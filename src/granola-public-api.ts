import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PUBLIC_API_BASE = "https://public-api.granola.ai/v1";
const ID_MAP_PATH = join(homedir(), ".granola-mcp", "idmap.json");

const NOTE_ID_PATTERN = /^not_[a-zA-Z0-9]{14}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolving a UUID walks pages newest-first, so cap the crawl rather than
// paging through an entire workspace on a typo.
const MAX_RESOLVE_PAGES = 40;
const PAGE_SIZE = 30;

export interface TranscriptSpeaker {
  source: "microphone" | "speaker";
  attribution?: "me" | "them";
  diarization_label?: string;
  name?: string;
}

export interface TranscriptUtterance {
  speaker: TranscriptSpeaker;
  text: string;
  start_time: string;
  end_time: string;
}

export interface NoteSummary {
  id: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  owner?: any;
}

export interface Note extends NoteSummary {
  attendees?: Array<{ name?: string | null; email: string }>;
  calendar_event?: any;
  folder_membership?: any;
  space_membership?: any;
  summary_markdown?: string;
  summary_text?: string;
  transcript?: TranscriptUtterance[];
  web_url?: string;
}

export class GranolaPublicApiClient {
  private readonly apiKey: string | undefined;
  private idMap: Record<string, string> | null = null;

  constructor(apiKey: string | undefined = process.env.GRANOLA_API_KEY) {
    this.apiKey = apiKey?.trim() || undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private assertConfigured(): string {
    if (!this.apiKey) {
      throw new Error(
        "GRANOLA_API_KEY is not set. Generate a key in Granola: Settings → " +
          "Connectors → API keys → Create new key, then set GRANOLA_API_KEY " +
          "in the granola MCP server's env block."
      );
    }
    return this.apiKey;
  }

  private async request<T>(path: string): Promise<T> {
    const key = this.assertConfigured();

    // Sustained limit is 5 req/s; a 429 here is normal under a UUID crawl
    // rather than an error worth surfacing.
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(`${PUBLIC_API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after")) || 1;
        await new Promise((r) => setTimeout(r, retryAfter * 1000 * (attempt + 1)));
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Granola public API rejected the key (${response.status}). ` +
            "Confirm the key is active and has the Personal + Public notes scopes."
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Granola public API error ${response.status}: ${body.slice(0, 300)}`
        );
      }

      return (await response.json()) as T;
    }

    throw new Error("Granola public API rate limit exceeded after retries.");
  }

  async listNotes(params: {
    pageSize?: number;
    cursor?: string;
    createdAfter?: string;
    createdBefore?: string;
    updatedAfter?: string;
    folderId?: string;
  } = {}): Promise<{ notes: NoteSummary[]; hasMore: boolean; cursor: string | null }> {
    const query = new URLSearchParams();
    query.set("page_size", String(params.pageSize ?? PAGE_SIZE));
    if (params.cursor) query.set("cursor", params.cursor);
    if (params.createdAfter) query.set("created_after", params.createdAfter);
    if (params.createdBefore) query.set("created_before", params.createdBefore);
    if (params.updatedAfter) query.set("updated_after", params.updatedAfter);
    if (params.folderId) query.set("folder_id", params.folderId);

    return this.request(`/notes?${query.toString()}`);
  }

  async getNote(noteId: string, includeTranscript = false): Promise<Note> {
    const suffix = includeTranscript ? "?include=transcript" : "";
    return this.request(`/notes/${noteId}${suffix}`);
  }

  async listFolders(): Promise<any> {
    return this.request("/folders");
  }

  private loadIdMap(): Record<string, string> {
    if (this.idMap) return this.idMap;
    try {
      this.idMap = JSON.parse(readFileSync(ID_MAP_PATH, "utf-8"));
    } catch {
      this.idMap = {};
    }
    return this.idMap!;
  }

  private saveIdMap(map: Record<string, string>): void {
    try {
      mkdirSync(dirname(ID_MAP_PATH), { recursive: true });
      writeFileSync(ID_MAP_PATH, JSON.stringify(map, null, 2));
    } catch {
      // A read-only home shouldn't break transcript fetching.
    }
  }

  private static uuidFromWebUrl(webUrl: string | undefined): string | null {
    const match = webUrl?.match(UUID_PATTERN.source.replace(/[$^]/g, ""));
    return match ? match[0].toLowerCase() : null;
  }

  /**
   * The public API only accepts `not_*` ids, but Granola share URLs and the
   * claude.ai connector both surface document UUIDs. The UUID is recoverable
   * from a note's web_url, so resolve by crawling pages newest-first and cache
   * the pairing permanently.
   */
  async resolveNoteId(
    idOrUuid: string,
    hints: { createdAfter?: string; createdBefore?: string } = {}
  ): Promise<string> {
    if (NOTE_ID_PATTERN.test(idOrUuid)) return idOrUuid;

    if (!UUID_PATTERN.test(idOrUuid)) {
      throw new Error(
        `"${idOrUuid}" is neither a not_* note id nor a document UUID.`
      );
    }

    const uuid = idOrUuid.toLowerCase();
    const map = this.loadIdMap();
    if (map[uuid]) return map[uuid];

    let cursor: string | undefined;
    for (let page = 0; page < MAX_RESOLVE_PAGES; page++) {
      const result = await this.listNotes({
        cursor,
        createdAfter: hints.createdAfter,
        createdBefore: hints.createdBefore,
      });

      for (const summary of result.notes) {
        if (map[uuid]) return map[uuid];
        const note = await this.getNote(summary.id);
        const noteUuid = GranolaPublicApiClient.uuidFromWebUrl(note.web_url);
        if (noteUuid) {
          map[noteUuid] = summary.id;
          if (noteUuid === uuid) {
            this.saveIdMap(map);
            return summary.id;
          }
        }
      }

      this.saveIdMap(map);
      if (!result.hasMore || !result.cursor) break;
      cursor = result.cursor;
    }

    throw new Error(
      `Could not resolve document UUID ${uuid} to a not_* id after ` +
        `${MAX_RESOLVE_PAGES} pages. Pass the not_* id directly, or narrow ` +
        "the search with created_after/created_before."
    );
  }

  async fetchTranscript(
    idOrUuid: string,
    hints: { createdAfter?: string; createdBefore?: string } = {}
  ): Promise<{ note: Note; utterances: TranscriptUtterance[] }> {
    const noteId = await this.resolveNoteId(idOrUuid, hints);
    const note = await this.getNote(noteId, true);
    return { note, utterances: note.transcript ?? [] };
  }
}

/**
 * Speaker names and diarization labels are optional in Granola's schema and are
 * absent unless the workspace has speaker identification producing them, so
 * fall back through name → diarization label → me/them attribution.
 */
export function speakerLabel(speaker: TranscriptSpeaker | undefined): string {
  if (!speaker) return "Unknown";
  if (speaker.name) return speaker.name;
  if (speaker.diarization_label) return speaker.diarization_label;
  if (speaker.attribution === "me") return "Me";
  if (speaker.attribution === "them") return "Them";
  return speaker.source === "microphone" ? "Me" : "Them";
}

export function formatTranscript(
  note: Note,
  utterances: TranscriptUtterance[]
): string {
  if (utterances.length === 0) {
    return `# ${note.title ?? note.id}\n\nNo transcript available for this note.`;
  }

  const start = new Date(utterances[0].start_time).getTime();
  const attendees = (note.attendees ?? [])
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");

  const namesPresent = utterances.some((u) => u.speaker?.name);
  const header = [
    `# ${note.title ?? note.id}`,
    `Note ID: ${note.id}`,
    note.web_url ? `URL: ${note.web_url}` : null,
    note.created_at ? `Created: ${note.created_at}` : null,
    attendees ? `Attendees: ${attendees}` : null,
    `Utterances: ${utterances.length}`,
    namesPresent
      ? null
      : "Speaker names unavailable from Granola for this note; labels are Me/Them per utterance with timestamps.",
  ]
    .filter(Boolean)
    .join("\n");

  const body = utterances
    .map((u) => {
      const offsetMs = new Date(u.start_time).getTime() - start;
      const total = Math.max(0, Math.floor(offsetMs / 1000));
      const stamp = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
        total % 60
      ).padStart(2, "0")}`;
      return `[${stamp}] ${speakerLabel(u.speaker)}: ${u.text}`;
    })
    .join("\n");

  return `${header}\n\n${body}`;
}
