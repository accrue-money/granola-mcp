#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { GranolaApiClient } from "./granola-api.js";
import { convertProseMirrorToMarkdown } from "./prosemirror-converter.js";

const apiClient = new GranolaApiClient();

const server = new Server(
  {
    name: "granola-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const tools: Tool[] = [
  {
    name: "search_granola_notes",
    description:
      "Search through Granola notes/documents by query string. Returns matching documents with their content.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find matching notes/documents",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 10)",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_granola_transcripts",
    description:
      "Search through Granola meeting transcripts by query string. Returns matching transcripts with their content.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find matching transcripts",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 10)",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_granola_events",
    description:
      "Search through Granola calendar events by query string. Returns matching events with details.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find matching calendar events",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 10)",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_granola_panels",
    description:
      "Search through Granola document panels (structured note sections) by query string.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find matching panels",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 10)",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_granola_document",
    description: "Get a specific Granola document by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The document ID to retrieve",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_granola_transcript",
    description: "Get a specific Granola transcript by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The transcript ID to retrieve",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "list_granola_documents",
    description: "List all Granola documents with basic metadata.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of documents to return (default: 50)",
          default: 50,
        },
      },
    },
  },
  {
    name: "list_granola_folders",
    description: "List all Granola folders (document lists), including shared folders.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_granola_folder_documents",
    description: "Get all documents in a folder by ID. Works for shared folders.",
    inputSchema: {
      type: "object",
      properties: {
        folder_id: {
          type: "string",
          description: "The folder ID to retrieve documents from",
        },
        limit: {
          type: "number",
          description: "Maximum number of documents to return (default: 50)",
        },
      },
      required: ["folder_id"],
    },
  },
  {
    name: "get_granola_shared_document",
    description: "Get full content of any document by ID (including shared documents).",
    inputSchema: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "The document ID to retrieve",
        },
      },
      required: ["document_id"],
    },
  },
  {
    name: "get_granola_raw_transcript",
    description: "Get raw utterance-level transcript with timestamps and speaker sources.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "The document ID to get transcript for",
        },
      },
      required: ["document_id"],
    },
  },
  {
    name: "list_granola_workspaces",
    description: "List all workspaces (organizations) you have access to.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "search_granola_notes": {
        const query = args?.query as string;
        const limit = (args?.limit as number) || 10;
        const results = await apiClient.searchDocuments(query, limit);

        const processedResults = await Promise.all(
          results.map(async (doc) => {
            let markdown = "";
            let hasContent = false;

            if (
              doc.last_viewed_panel &&
              typeof doc.last_viewed_panel === "object" &&
              doc.last_viewed_panel.content &&
              typeof doc.last_viewed_panel.content === "object" &&
              doc.last_viewed_panel.content.type === "doc"
            ) {
              markdown = convertProseMirrorToMarkdown(
                doc.last_viewed_panel.content
              );
              hasContent = markdown.trim().length > 0;
            } else if (
              doc.notes &&
              typeof doc.notes === "object" &&
              doc.notes.type === "doc"
            ) {
              markdown = convertProseMirrorToMarkdown(doc.notes);
              hasContent = markdown.trim().length > 0;
            }

            return {
              id: doc.id,
              title: doc.title || "Untitled",
              markdown: markdown.substring(0, 2000) || "",
              content_preview: markdown.substring(0, 500) || "",
              has_content: hasContent,
              created_at: doc.created_at,
              updated_at: doc.updated_at,
            };
          })
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  count: processedResults.length,
                  results: processedResults,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "search_granola_transcripts": {
        const query = args?.query as string;
        const limit = (args?.limit as number) || 10;
        const results = await apiClient.searchDocuments(query, limit);

        const transcriptResults = results
          .filter((doc) => doc.type === "meeting")
          .map((doc) => {
            let markdown = "";
            if (doc.last_viewed_panel?.content) {
              markdown = convertProseMirrorToMarkdown(
                doc.last_viewed_panel.content
              );
            }
            return {
              id: doc.id,
              meeting_id: doc.id,
              title: doc.title,
              content: markdown.substring(0, 1000) || "",
            };
          })
          .slice(0, limit);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  count: transcriptResults.length,
                  results: transcriptResults,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "search_granola_events": {
        const query = args?.query as string;
        const limit = (args?.limit as number) || 10;
        const allDocs = await apiClient.getAllDocuments();

        const eventResults = allDocs
          .filter((doc) => {
            const event = doc.google_calendar_event;
            if (!event) return false;
            const summary = event.summary?.toLowerCase() || "";
            const description = event.description?.toLowerCase() || "";
            const lowerQuery = query.toLowerCase();
            return (
              summary.includes(lowerQuery) || description.includes(lowerQuery)
            );
          })
          .slice(0, limit)
          .map((doc) => ({
            id: doc.google_calendar_event?.id || doc.id,
            summary: doc.google_calendar_event?.summary,
            description: doc.google_calendar_event?.description?.substring(
              0,
              500
            ),
            start: doc.google_calendar_event?.start,
            end: doc.google_calendar_event?.end,
            attendees: doc.google_calendar_event?.attendees,
            htmlLink: doc.google_calendar_event?.htmlLink,
          }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  count: eventResults.length,
                  results: eventResults,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "search_granola_panels": {
        const query = args?.query as string;
        const limit = (args?.limit as number) || 10;
        const results = await apiClient.searchDocuments(query, limit);

        const panelResults = results
          .filter((doc) => doc.last_viewed_panel)
          .map((doc) => {
            const panel = doc.last_viewed_panel;
            let markdown = "";
            if (panel?.content) {
              markdown = convertProseMirrorToMarkdown(panel.content);
            }
            return {
              id: panel?.id || doc.id,
              document_id: doc.id,
              heading: panel?.heading || doc.title,
              content: markdown.substring(0, 500) || "",
            };
          })
          .slice(0, limit);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  count: panelResults.length,
                  results: panelResults,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_granola_document": {
        const id = args?.id as string;
        const doc = await apiClient.getDocumentById(id);
        if (!doc) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Document with id ${id} not found`,
                }),
              },
            ],
            isError: true,
          };
        }

        let markdown = "";
        if (
          doc.last_viewed_panel &&
          typeof doc.last_viewed_panel === "object" &&
          doc.last_viewed_panel.content &&
          typeof doc.last_viewed_panel.content === "object" &&
          doc.last_viewed_panel.content.type === "doc"
        ) {
          markdown = convertProseMirrorToMarkdown(
            doc.last_viewed_panel.content
          );
        } else if (
          doc.notes &&
          typeof doc.notes === "object" &&
          doc.notes.type === "doc"
        ) {
          markdown = convertProseMirrorToMarkdown(doc.notes);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: doc.id,
                  title: doc.title || "Untitled",
                  markdown,
                  created_at: doc.created_at,
                  updated_at: doc.updated_at,
                  metadata: {
                    type: doc.type,
                    people: doc.people,
                    google_calendar_event: doc.google_calendar_event,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_granola_transcript": {
        const id = args?.id as string;
        const doc = await apiClient.getDocumentById(id);
        if (!doc || doc.type !== "meeting") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Transcript with id ${id} not found`,
                }),
              },
            ],
            isError: true,
          };
        }

        let markdown = "";
        if (doc.last_viewed_panel?.content) {
          markdown = convertProseMirrorToMarkdown(
            doc.last_viewed_panel.content
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: doc.id,
                  meeting_id: doc.id,
                  title: doc.title,
                  content: markdown,
                  created_at: doc.created_at,
                  updated_at: doc.updated_at,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "list_granola_documents": {
        const limit = (args?.limit as number) || 50;
        const allDocs = await apiClient.getAllDocuments();
        const docs = allDocs.slice(0, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: docs.length,
                  documents: docs.map((doc) => ({
                    id: doc.id,
                    title: doc.title || "Untitled",
                    created_at: doc.created_at,
                    updated_at: doc.updated_at,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "list_granola_folders": {
        const folders = await apiClient.fetchDocumentLists();
        const result = folders.map((folder: any) => ({
          id: folder.id,
          title: folder.title || folder.name,
          description: folder.description,
          icon: folder.icon,
          document_count: folder.documents?.length || 0,
          parent_folder_id: folder.parent_document_list_id,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_granola_folder_documents": {
        const folderId = args?.folder_id as string;
        const limit = (args?.limit as number) || 50;

        const folders = await apiClient.fetchDocumentLists();
        const folder = folders.find((f: any) => f.id === folderId);

        if (!folder) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Folder not found" }) }],
            isError: true,
          };
        }

        const allDocIds = folder.document_ids || folder.documents?.map((d: any) => d.id) || [];
        const docIds = allDocIds.slice(0, limit);

        if (docIds.length === 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ folder_title: folder.title || folder.name, documents: [] }) }],
          };
        }

        const documents = await apiClient.fetchDocumentsBatch(docIds);
        const result = {
          folder_title: folder.title || folder.name,
          folder_id: folder.id,
          total_documents: allDocIds.length,
          returned_documents: documents.length,
          documents: documents.map((doc: any) => ({
            id: doc.id,
            title: doc.title || "Untitled",
            created_at: doc.created_at,
            updated_at: doc.updated_at,
            type: doc.type,
            owner_id: doc.user_id,
          })),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_granola_shared_document": {
        const documentId = args?.document_id as string;
        const documents = await apiClient.fetchDocumentsBatch([documentId]);

        if (!documents || documents.length === 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Document not found" }) }],
            isError: true,
          };
        }

        const doc = documents[0];
        let markdown = "";
        if (doc.last_viewed_panel?.content?.type === "doc") {
          markdown = convertProseMirrorToMarkdown(doc.last_viewed_panel.content);
        } else if (doc.notes?.type === "doc") {
          markdown = convertProseMirrorToMarkdown(doc.notes);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: doc.id,
              title: doc.title || "Untitled",
              owner_id: doc.user_id,
              workspace_id: doc.workspace_id,
              created_at: doc.created_at,
              updated_at: doc.updated_at,
              type: doc.type,
              content: markdown || doc.content || "No content available",
              google_calendar_event: doc.google_calendar_event,
            }, null, 2),
          }],
        };
      }

      case "get_granola_raw_transcript": {
        const documentId = args?.document_id as string;
        const utterances = await apiClient.fetchDocumentTranscript(documentId);

        if (!utterances || utterances.length === 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "No transcript found for this document" }) }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              document_id: documentId,
              utterance_count: utterances.length,
              utterances: utterances.map((u: any) => ({
                source: u.source,
                text: u.text,
                start: u.start_timestamp,
                end: u.end_timestamp,
                confidence: u.confidence,
              })),
            }, null, 2),
          }],
        };
      }

      case "list_granola_workspaces": {
        const workspaces = await apiClient.fetchWorkspaces();
        // Return raw data to preserve all fields from API
        return {
          content: [{ type: "text", text: JSON.stringify(workspaces, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Granola MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
