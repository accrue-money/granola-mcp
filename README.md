# granola-mcp-plus

A Model Context Protocol (MCP) server that provides access to your Granola notes, documents, transcripts, and calendar events using the Granola API.

**Enhanced fork** with shared folder access, raw transcripts, workspace support, and automatic token refresh.

## Features

### Original Tools
- **search_granola_notes** - Search through all your Granola documents/notes
- **search_granola_transcripts** - Find meeting transcripts by content
- **search_granola_events** - Search calendar events
- **search_granola_panels** - Search structured note panels
- **get_granola_document** - Retrieve specific documents by ID
- **get_granola_transcript** - Get a specific transcript
- **list_granola_documents** - List all available documents

### New Tools (v1.1.0)
- **list_granola_folders** - List all folders including shared folders from your team
- **get_granola_folder_documents** - Get documents in a folder by ID (works for shared folders)
- **get_granola_shared_document** - Fetch full content of any document by ID (including shared)
- **get_granola_raw_transcript** - Get raw utterance-level transcript with timestamps and speaker sources
- **list_granola_workspaces** - List all workspaces/organizations you have access to

### New in v1.2.0 (May 2026)
- **Encrypted-token-era auth support.** Granola.app's May 2026 release encrypted `supabase.json` → `supabase.json.enc` and stopped writing plaintext refresh tokens. v1.2.0 reads JWT from the plaintext `stored-accounts.json` sibling file (which Granola.app auto-refreshes during normal usage) and falls back to legacy `supabase.json` only for older Granola installs. No more 401s after Granola updates.

### Improvements
- Automatic WorkOS token refresh (prevents auth failures after 6 hours)
- Access to shared team folders and documents

## Installation

### Via npx (Recommended)

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "granola": {
      "command": "npx",
      "args": ["-y", "granola-mcp-plus"]
    }
  }
}
```

### From Source

```bash
git clone https://github.com/accrue-money/granola-mcp.git
cd granola-mcp
npm install
npm run build
```

Then configure with the local path:

```json
{
  "mcpServers": {
    "granola": {
      "command": "node",
      "args": ["/path/to/granola-mcp/dist/index.js"]
    }
  }
}
```

## Requirements

- Granola desktop app must be installed and logged in
- Credentials are read from: `~/Library/Application Support/Granola/supabase.json`

## Tool Reference

### list_granola_folders

List all folders (document lists), including shared folders from your team.

**Input:** None

**Output:**
```json
[
  {
    "id": "folder-uuid",
    "title": "Folder Name",
    "description": "Optional description",
    "icon": { "type": "icon", "color": "blue", "value": "FolderIcon" },
    "document_count": 48,
    "parent_folder_id": null
  }
]
```

### get_granola_folder_documents

Get all documents in a folder by ID. Works for shared folders.

**Input:**
- `folder_id` (required): The folder ID
- `limit` (optional): Max documents to return (default: 50)

**Output:**
```json
{
  "folder_title": "Folder Name",
  "folder_id": "folder-uuid",
  "total_documents": 48,
  "returned_documents": 5,
  "documents": [
    {
      "id": "doc-uuid",
      "title": "Meeting Title",
      "created_at": "2026-01-26T19:47:34.882Z",
      "updated_at": "2026-01-27T13:42:44.165Z",
      "type": "meeting",
      "owner_id": "user-uuid"
    }
  ]
}
```

### get_granola_shared_document

Get full content of any document by ID (including shared documents).

**Input:**
- `document_id` (required): The document ID

**Output:**
```json
{
  "id": "doc-uuid",
  "title": "Meeting Title",
  "owner_id": "user-uuid",
  "workspace_id": "workspace-uuid",
  "created_at": "2026-01-26T19:47:34.882Z",
  "updated_at": "2026-01-27T13:42:44.165Z",
  "type": "meeting",
  "content": "### Meeting Notes\n\n- Key point 1\n- Key point 2",
  "google_calendar_event": {
    "summary": "Meeting Title",
    "attendees": [...],
    "start": {...},
    "end": {...}
  }
}
```

### get_granola_raw_transcript

Get raw utterance-level transcript with timestamps and speaker sources.

**Input:**
- `document_id` (required): The document ID

**Output:**
```json
{
  "document_id": "doc-uuid",
  "utterance_count": 267,
  "utterances": [
    {
      "source": "microphone",
      "text": "Let me explain the proposal...",
      "start": "2026-01-26T19:47:47.672Z",
      "end": "2026-01-26T19:48:07.752Z"
    },
    {
      "source": "system",
      "text": "That sounds good.",
      "start": "2026-01-26T19:48:08.030Z",
      "end": "2026-01-26T19:48:09.190Z"
    }
  ]
}
```

### list_granola_workspaces

List all workspaces (organizations) you have access to.

**Input:** None

**Output:**
```json
[
  {
    "workspace": {
      "workspace_id": "workspace-uuid",
      "slug": "company.com",
      "display_name": "Company Name",
      "plan_type": "business"
    },
    "role": "member"
  }
]
```

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev

# Run directly
npm start
```

## License

MIT

## Credits

Forked from [btn0s/granola-mcp](https://github.com/btn0s/granola-mcp)
