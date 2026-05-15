import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const GRANOLA_APP_SUPPORT_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "Granola"
);

export interface GranolaDocument {
  id: string;
  title?: string;
  content?: string;
  markdown?: string;
  created_at?: string;
  updated_at?: string;
  last_viewed_panel?: any;
  [key: string]: any;
}

export interface GranolaApiResponse {
  docs: GranolaDocument[];
  [key: string]: any;
}

export class GranolaApiClient {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private readonly apiUrl = "https://api.granola.ai/v2/get-documents";

  // As of May 2026, Granola.app encrypts supabase.json -> supabase.json.enc.
  // The plaintext access_token now lives in stored-accounts.json instead, which
  // Granola.app auto-refreshes on normal usage (~6h JWT lifetime). Try that
  // path first; fall back to legacy supabase.json for older Granola installs.
  private loadCredentials(): string | null {
    const storedAccountsToken = this.tryLoadFromStoredAccounts();
    if (storedAccountsToken) return storedAccountsToken;

    const supabaseToken = this.tryLoadFromSupabaseJson();
    if (supabaseToken) return supabaseToken;

    console.error(
      `Granola auth failed: neither stored-accounts.json nor supabase.json could be read at ${GRANOLA_APP_SUPPORT_PATH}. Is Granola.app installed and signed in?`
    );
    return null;
  }

  private tryLoadFromStoredAccounts(): string | null {
    try {
      const path = join(GRANOLA_APP_SUPPORT_PATH, "stored-accounts.json");
      const fileContent = readFileSync(path, "utf-8");
      const data = JSON.parse(fileContent);

      const accounts = JSON.parse(data.accounts);
      if (!Array.isArray(accounts) || accounts.length === 0) return null;

      const tokens = JSON.parse(accounts[0].tokens);
      const accessToken = tokens.access_token;
      if (!accessToken) return null;

      // stored-accounts.json doesn't carry expires_in/obtained_at; assume 6h
      // from the file's mtime. Granola.app refreshes the file as part of
      // normal usage, so re-reading on cache miss is sufficient.
      this.tokenExpiry = Date.now() + 6 * 60 * 60 * 1000;
      this.accessToken = accessToken;
      return accessToken;
    } catch {
      return null;
    }
  }

  private tryLoadFromSupabaseJson(): string | null {
    try {
      const credsPath = join(GRANOLA_APP_SUPPORT_PATH, "supabase.json");
      const fileContent = readFileSync(credsPath, "utf-8");
      const data = JSON.parse(fileContent);

      const workosTokens = JSON.parse(data.workos_tokens);
      const accessToken = workosTokens.access_token;
      if (!accessToken) return null;

      const expiresIn = workosTokens.expires_in || 21600;
      const obtainedAt = workosTokens.obtained_at || Date.now();

      this.tokenExpiry = obtainedAt + expiresIn * 1000;
      this.accessToken = accessToken;
      return accessToken;
    } catch {
      return null;
    }
  }

  private getAccessToken(): string | null {
    if (!this.accessToken || Date.now() >= this.tokenExpiry - 5 * 60 * 1000) {
      return this.loadCredentials();
    }
    return this.accessToken;
  }

  private async refreshAccessToken(): Promise<string | null> {
    const credsPath = join(GRANOLA_APP_SUPPORT_PATH, "supabase.json");

    try {
      const fileContent = readFileSync(credsPath, "utf-8");
      const data = JSON.parse(fileContent);
      const workosTokens = JSON.parse(data.workos_tokens);

      const response = await fetch("https://api.workos.com/user_management/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "client_01JZJ0XBDAT8PHJWQY09Y0VD61",
          grant_type: "refresh_token",
          refresh_token: workosTokens.refresh_token,
        }),
      });

      if (!response.ok) {
        console.error("Token refresh failed:", response.status);
        return null;
      }

      const newTokens = (await response.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      workosTokens.access_token = newTokens.access_token;
      workosTokens.refresh_token = newTokens.refresh_token;
      workosTokens.obtained_at = Date.now();
      workosTokens.expires_in = newTokens.expires_in;

      data.workos_tokens = JSON.stringify(workosTokens);

      writeFileSync(credsPath, JSON.stringify(data));

      this.accessToken = null;
      this.tokenExpiry = 0;
      return this.loadCredentials();
    } catch (error) {
      console.error("Token refresh error:", error);
      return null;
    }
  }

  async fetchDocuments(
    limit: number = 100,
    offset: number = 0
  ): Promise<GranolaDocument[]> {
    const token = this.getAccessToken();
    if (!token) {
      throw new Error("Failed to load Granola credentials");
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": "Granola/5.354.0",
      "X-Client-Version": "5.354.0",
    };

    const body = {
      limit,
      offset,
      include_last_viewed_panel: true,
    };

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(
          `Granola API error: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as GranolaApiResponse;
      return data.docs || [];
    } catch (error) {
      console.error("Error fetching documents from Granola API:", error);
      throw error;
    }
  }

  async getAllDocuments(): Promise<GranolaDocument[]> {
    const allDocs: GranolaDocument[] = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const docs = await this.fetchDocuments(limit, offset);
      if (docs.length === 0) {
        break;
      }
      allDocs.push(...docs);
      offset += limit;
      if (offset > 10000) {
        break;
      }
    }

    return allDocs;
  }

  async searchDocuments(
    query: string,
    limit: number = 10
  ): Promise<GranolaDocument[]> {
    const allDocs = await this.getAllDocuments();
    const lowerQuery = query.toLowerCase();

    return allDocs
      .filter((doc) => {
        const title = doc.title?.toLowerCase() || "";
        const markdown = doc.markdown?.toLowerCase() || "";
        const content = doc.content?.toLowerCase() || "";
        return (
          title.includes(lowerQuery) ||
          markdown.includes(lowerQuery) ||
          content.includes(lowerQuery)
        );
      })
      .slice(0, limit);
  }

  async getDocumentById(id: string): Promise<GranolaDocument | null> {
    const allDocs = await this.getAllDocuments();
    return allDocs.find((doc) => doc.id === id) || null;
  }

  async fetchDocumentLists(): Promise<any[]> {
    const token = this.getAccessToken();
    if (!token) throw new Error("Failed to load Granola credentials");

    const response = await fetch("https://api.granola.ai/v2/get-document-lists", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "*/*",
        "User-Agent": "Granola/5.354.0",
        "X-Client-Version": "5.354.0",
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = (await response.json()) as { document_lists?: any[]; lists?: any[] } | any[];
    if (Array.isArray(data)) return data;
    return data.document_lists || data.lists || [];
  }

  async fetchDocumentsBatch(documentIds: string[]): Promise<GranolaDocument[]> {
    const token = this.getAccessToken();
    if (!token) throw new Error("Failed to load Granola credentials");

    const response = await fetch("https://api.granola.ai/v1/get-documents-batch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "*/*",
        "User-Agent": "Granola/5.354.0",
        "X-Client-Version": "5.354.0",
      },
      body: JSON.stringify({
        document_ids: documentIds,
        include_last_viewed_panel: true,
      }),
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = (await response.json()) as { documents?: GranolaDocument[]; docs?: GranolaDocument[] };
    return data.documents || data.docs || [];
  }

  async fetchDocumentTranscript(documentId: string): Promise<any[]> {
    const token = this.getAccessToken();
    if (!token) throw new Error("Failed to load Granola credentials");

    const response = await fetch("https://api.granola.ai/v1/get-document-transcript", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "*/*",
        "User-Agent": "Granola/5.354.0",
        "X-Client-Version": "5.354.0",
      },
      body: JSON.stringify({ document_id: documentId }),
    });

    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return (await response.json()) as any[];
  }

  async fetchWorkspaces(): Promise<any[]> {
    const token = this.getAccessToken();
    if (!token) throw new Error("Failed to load Granola credentials");

    const response = await fetch("https://api.granola.ai/v1/get-workspaces", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "*/*",
        "User-Agent": "Granola/5.354.0",
        "X-Client-Version": "5.354.0",
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = (await response.json()) as { workspaces?: any[] } | any[];
    return Array.isArray(data) ? data : (data.workspaces || []);
  }
}
