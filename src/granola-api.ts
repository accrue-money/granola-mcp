import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";
import { createDecipheriv, pbkdf2Sync } from "crypto";

const GRANOLA_APP_SUPPORT_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "Granola"
);

// Granola.app v5.354+ wraps a 32-byte AES-256-GCM data encryption key (DEK)
// in storage.dek via Electron's safeStorage (Chromium OSCrypt: v10 prefix +
// AES-128-CBC + PBKDF2-SHA1(keychain-key-base64-string, "saltysalt", 1003)).
// Per-file blobs are [12-byte IV][ciphertext][16-byte GCM tag].
let cachedDek: Buffer | null = null;

function loadGranolaDek(): Buffer | null {
  if (cachedDek) return cachedDek;
  try {
    const keyB64 = execFileSync(
      "security",
      ["find-generic-password", "-s", "Granola Safe Storage", "-w"],
      { encoding: "utf-8" }
    ).trim();
    const password = Buffer.from(keyB64, "utf-8");
    const kek = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const dekBlob = readFileSync(
      join(GRANOLA_APP_SUPPORT_PATH, "storage.dek")
    );
    if (dekBlob.subarray(0, 3).toString() !== "v10") return null;
    const iv = Buffer.alloc(16, 0x20);
    const decipher = createDecipheriv("aes-128-cbc", kek, iv);
    const dekBase64 = Buffer.concat([
      decipher.update(dekBlob.subarray(3)),
      decipher.final(),
    ]).toString("utf-8");
    const dek = Buffer.from(dekBase64, "base64");
    if (dek.length !== 32) return null;
    cachedDek = dek;
    return dek;
  } catch {
    return null;
  }
}

function decryptGranolaBlob(blob: Buffer): string | null {
  try {
    const dek = loadGranolaDek();
    if (!dek) return null;
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(12, blob.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", dek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    return null;
  }
}

function jwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8")
    );
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

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

  // As of June 2026, Granola.app v5.354+ writes ONLY the encrypted
  // stored-accounts.json.enc; the plaintext file is no longer refreshed.
  // Try encrypted first, then plaintext (older installs), then legacy
  // supabase.json.
  private loadCredentials(): string | null {
    const encToken = this.tryLoadFromStoredAccountsEnc();
    if (encToken) return encToken;

    const storedAccountsToken = this.tryLoadFromStoredAccounts();
    if (storedAccountsToken) return storedAccountsToken;

    const supabaseToken = this.tryLoadFromSupabaseJson();
    if (supabaseToken) return supabaseToken;

    console.error(
      "Granola auth failed: no usable token in stored-accounts.json.enc, " +
        `stored-accounts.json, or supabase.json at ${GRANOLA_APP_SUPPORT_PATH}. ` +
        "Granola.app v7+ no longer writes storage.dek, so the encrypted store " +
        "cannot be decrypted. Set GRANOLA_API_KEY (Granola: Settings → " +
        "Connectors → API keys) to use the supported public API instead."
    );
    return null;
  }

  private extractAccessTokenFromStoredAccountsPayload(
    fileContent: string
  ): string | null {
    const data = JSON.parse(fileContent);
    const accounts =
      typeof data.accounts === "string"
        ? JSON.parse(data.accounts)
        : data.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) return null;
    const rawTokens = accounts[0].tokens;
    const tokens =
      typeof rawTokens === "string" ? JSON.parse(rawTokens) : rawTokens;
    return tokens?.access_token ?? null;
  }

  private tryLoadFromStoredAccountsEnc(): string | null {
    try {
      const path = join(
        GRANOLA_APP_SUPPORT_PATH,
        "stored-accounts.json.enc"
      );
      const blob = readFileSync(path);
      const plaintext = decryptGranolaBlob(blob);
      if (!plaintext) return null;
      const accessToken =
        this.extractAccessTokenFromStoredAccountsPayload(plaintext);
      if (!accessToken) return null;
      this.tokenExpiry = Date.now() + 6 * 60 * 60 * 1000;
      this.accessToken = accessToken;
      return accessToken;
    } catch {
      return null;
    }
  }

  private tryLoadFromStoredAccounts(): string | null {
    try {
      const path = join(GRANOLA_APP_SUPPORT_PATH, "stored-accounts.json");
      const fileContent = readFileSync(path, "utf-8");
      const accessToken =
        this.extractAccessTokenFromStoredAccountsPayload(fileContent);
      if (!accessToken) return null;

      // Granola stopped refreshing the plaintext file once it moved to
      // encrypted-only storage, so trusting it unconditionally returns a token
      // months past expiry and the API answers with a bare 401 instead of an
      // auth error. Honour the JWT's own expiry rather than assuming 6 hours.
      const expiry = jwtExpiryMs(accessToken);
      if (expiry !== null && Date.now() >= expiry) {
        console.error(
          `Granola auth: ${path} holds a token that expired at ` +
            `${new Date(expiry).toISOString()}. Granola no longer refreshes ` +
            "this file; the encrypted store could not be read."
        );
        return null;
      }

      this.tokenExpiry = expiry ?? Date.now() + 6 * 60 * 60 * 1000;
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
