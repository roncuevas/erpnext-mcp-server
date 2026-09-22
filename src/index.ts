#!/usr/bin/env node

/**
 * ERPNext MCP Server
 * This server provides integration with the ERPNext/Frappe API, allowing:
 * - Authentication with ERPNext
 * - Fetching documents from ERPNext
 * - Querying lists of documents
 * - Creating and updating documents
 * - Running reports
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";

type FilterOperator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "like" | "not like" | "in" | "not in" | "is" | "between";
type Filter = [field: string, operator: FilterOperator, value: unknown];
type FilterInput = Filter[] | Record<string, unknown>;

interface DocListOptions {
  fields?: string[];
  filters?: FilterInput;
  orFilters?: FilterInput;
  limit?: number;
  limitStart?: number;
  orderBy?: string;
  expand?: string[];
}

interface ERPNextErrorPayload {
  exc_type?: string;
  exception?: string;
  exc?: string;
  message?: string;
}

function normalizeFilters(filters?: FilterInput): Filter[] | undefined {
  if (!filters) return undefined;
  if (Array.isArray(filters)) return filters;
  return Object.entries(filters).map(([field, value]) => [field, "=", value]);
}

function requiredString(
  args: { [key: string]: unknown } | undefined,
  name: string
): string {
  const value = args?.[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `${name} is required`);
  }
  return value.trim();
}

function parseFilterInput(value: unknown): FilterInput | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const filter of value) {
      if (!Array.isArray(filter) || filter.length !== 3 || typeof filter[0] !== "string") {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Filters must use [field, operator, value] tuples"
        );
      }
    }
    return value as Filter[];
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new McpError(ErrorCode.InvalidParams, "Filters must be an array or object");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { data: value }
  };
}

// ERPNext API client configuration
class ERPNextClient {
  private baseUrl: string;
  private axiosInstance: AxiosInstance;
  private authenticated: boolean = false;
  private readonly timeoutMs: number;
  private readonly allowedMethods: Set<string>;

  constructor() {
    // Get ERPNext configuration from environment variables
    this.baseUrl = process.env.ERPNEXT_URL || '';
    
    // Validate configuration
    if (!this.baseUrl) {
      throw new Error("ERPNEXT_URL environment variable is required");
    }
    
    // Remove trailing slash if present
    this.baseUrl = this.baseUrl.replace(/\/$/, '');
    
    const configuredTimeout = Number(process.env.ERPNEXT_TIMEOUT_MS || 15000);
    if (!Number.isInteger(configuredTimeout) || configuredTimeout <= 0) {
      throw new Error("ERPNEXT_TIMEOUT_MS must be a positive integer");
    }
    this.timeoutMs = configuredTimeout;
    this.allowedMethods = new Set(
      (process.env.ERPNEXT_ALLOWED_METHODS || "")
        .split(",")
        .map(method => method.trim())
        .filter(Boolean)
    );

    // Initialize axios instance
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    // Configure authentication if credentials provided
    const apiKey = process.env.ERPNEXT_API_KEY;
    const apiSecret = process.env.ERPNEXT_API_SECRET;
    const accessToken = process.env.ERPNEXT_ACCESS_TOKEN;
    
    if (accessToken) {
      this.axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
      this.authenticated = true;
    } else if (apiKey && apiSecret) {
      this.axiosInstance.defaults.headers.common['Authorization'] = 
        `token ${apiKey}:${apiSecret}`;
      this.authenticated = true;
    }
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  private formatError(error: unknown): string {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error.message : "Unknown error";
    }

    const payload = error.response?.data as ERPNextErrorPayload | undefined;
    const details = payload?.exception || payload?.exc_type || payload?.message;
    if (details) return `${error.message}: ${details}`;
    return error.message;
  }

  // Get a document by doctype and name
  async getDocument(doctype: string, name: string): Promise<any> {
    try {
      const response = await this.axiosInstance.get(
        `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`
      );
      return response.data.data;
    } catch (error: unknown) {
      throw new Error(`Failed to get ${doctype} ${name}: ${this.formatError(error)}`);
    }
  }

  // Get list of documents for a doctype
  async getDocList(doctype: string, options: DocListOptions = {}): Promise<unknown[]> {
    try {
      const params: Record<string, string | number> = {};

      if (options.fields?.length) {
        params.fields = JSON.stringify(options.fields);
      }
      const filters = normalizeFilters(options.filters);
      if (filters) {
        params.filters = JSON.stringify(filters);
      }
      const orFilters = normalizeFilters(options.orFilters);
      if (orFilters) {
        params.or_filters = JSON.stringify(orFilters);
      }
      if (options.limit !== undefined) params.limit_page_length = options.limit;
      if (options.limitStart !== undefined) params.limit_start = options.limitStart;
      if (options.orderBy) params.order_by = options.orderBy;
      if (options.expand?.length) params.expand = JSON.stringify(options.expand);

      const response = await this.axiosInstance.get(
        `/api/resource/${encodeURIComponent(doctype)}`,
        { params }
      );
      return response.data.data;
    } catch (error: unknown) {
      throw new Error(`Failed to get ${doctype} list: ${this.formatError(error)}`);
    }
  }

  // Create a new document
  async createDocument(doctype: string, doc: Record<string, any>): Promise<any> {
    try {
      const response = await this.axiosInstance.post(
        `/api/resource/${encodeURIComponent(doctype)}`,
        doc
      );
      return response.data.data;
    } catch (error: unknown) {
      throw new Error(`Failed to create ${doctype}: ${this.formatError(error)}`);
    }
  }

  // Update an existing document
  async updateDocument(doctype: string, name: string, doc: Record<string, any>): Promise<any> {
    try {
      const response = await this.axiosInstance.put(
        `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
        doc
      );
      return response.data.data;
    } catch (error: unknown) {
      throw new Error(`Failed to update ${doctype} ${name}: ${this.formatError(error)}`);
    }
  }

  // Get DocType metadata without requiring an existing document.
  async getDocTypeMeta(doctype: string): Promise<unknown> {
    const cacheKey = doctype.trim();
    const cached = doctypeCache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.axiosInstance.get(
        `/api/v2/doctype/${encodeURIComponent(doctype)}/meta`
      );
      const metadata = response.data.data ?? response.data.message ?? response.data;
      doctypeCache.set(cacheKey, metadata);
      return metadata;
    } catch (error: unknown) {
      // Fallback keeps compatibility with older Frappe installations.
      try {
        const response = await this.axiosInstance.get(
          `/api/resource/DocType/${encodeURIComponent(doctype)}`
        );
        const metadata = response.data.data;
        doctypeCache.set(cacheKey, metadata);
        return metadata;
      } catch (fallbackError: unknown) {
        throw new Error(`Failed to get metadata for ${doctype}: ${this.formatError(fallbackError)}`);
      }
    }
  }

  // Run a report
  async runReport(reportName: string, filters?: Record<string, any>): Promise<any> {
    try {
      const response = await this.axiosInstance.get(`/api/method/frappe.desk.query_report.run`, {
        params: {
          report_name: reportName,
          filters: filters ? JSON.stringify(filters) : undefined
        }
      });
      return response.data.message;
    } catch (error: any) {
      throw new Error(`Failed to run report ${reportName}: ${error?.message || 'Unknown error'}`);
    }
  }

  // Call a server-side API method
  async callMethod(method: string, args?: Record<string, any>, httpMethod: "GET" | "POST" = "POST"): Promise<any> {
    try {
      if (this.allowedMethods.size > 0 && !this.allowedMethods.has(method)) {
        throw new Error(`Method is not allowed by ERPNEXT_ALLOWED_METHODS: ${method}`);
      }
      if (httpMethod !== "GET" && httpMethod !== "POST") {
        throw new Error(`Unsupported HTTP method: ${httpMethod}`);
      }
      // Encode each dotted segment so unusual characters don't break the URL.
      const encodedMethod = method.split('.').map(encodeURIComponent).join('.');
      let response;
      if (httpMethod === "GET") {
        response = await this.axiosInstance.get(`/api/method/${encodedMethod}`, { params: args });
      } else {
        response = await this.axiosInstance.post(`/api/method/${encodedMethod}`, args);
      }
      return response.data.message;
    } catch (error: any) {
      throw new Error(`Failed to call method ${method}: ${error?.message || 'Unknown error'}`);
    }
  }

  // Delete a document
  async deleteDocument(doctype: string, name: string): Promise<void> {
    try {
      await this.axiosInstance.delete(
        `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`
      );
    } catch (error: any) {
      throw new Error(`Failed to delete ${doctype} ${name}: ${error?.message || 'Unknown error'}`);
    }
  }

  // Get all available DocTypes
  async getAllDocTypes(): Promise<string[]> {
    try {
      // Use the standard REST API to fetch DocTypes
      const response = await this.axiosInstance.get('/api/resource/DocType', {
        params: {
          fields: JSON.stringify(["name"]),
          limit_page_length: 500 // Get more doctypes at once
        }
      });
      
      if (response.data && response.data.data) {
        return response.data.data.map((item: any) => item.name);
      }
      
      return [];
    } catch (error: any) {
      console.error("Failed to get DocTypes:", error?.message || 'Unknown error');
      
      // Try an alternative approach if the first one fails
      try {
        // Try using the method API to get doctypes
        const altResponse = await this.axiosInstance.get('/api/method/frappe.desk.search.search_link', {
          params: {
            doctype: 'DocType',
            txt: '',
            limit: 500
          }
        });
        
        if (altResponse.data && altResponse.data.results) {
          return altResponse.data.results.map((item: any) => item.value);
        }
        
        return [];
      } catch (altError: any) {
        console.error("Alternative DocType fetch failed:", altError?.message || 'Unknown error');
        
        // Fallback: Return a list of common DocTypes
        return [
          "Customer", "Supplier", "Item", "Sales Order", "Purchase Order",
          "Sales Invoice", "Purchase Invoice", "Employee", "Lead", "Opportunity",
          "Quotation", "Payment Entry", "Journal Entry", "Stock Entry"
        ];
      }
    }
  }
}

// Cache for doctype metadata
const doctypeCache = new Map<string, any>();

// Initialize ERPNext client
const erpnext = new ERPNextClient();

// Create an MCP server with capabilities for resources and tools
const server = new Server(
  {
    name: "erpnext-server",
    version: "0.1.0"
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    }
  }
);

/**
 * Handler for listing available ERPNext resources.
 * Exposes DocTypes list as a resource and common doctypes as individual resources.
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // List of common DocTypes to expose as individual resources
  const commonDoctypes = [
    "Customer",
    "Supplier",
    "Item",
    "Sales Order",
    "Purchase Order",
    "Sales Invoice",
    "Purchase Invoice",
    "Employee"
  ];

  const resources = [
    // Add a resource to get all doctypes
    {
      uri: "erpnext://DocTypes",
      name: "All DocTypes",
      mimeType: "application/json",
      description: "List of all available DocTypes in the ERPNext instance"
    }
  ];

  return {
    resources
  };
});

/**
 * Handler for resource templates.
 * Allows querying ERPNext documents by doctype and name.
 */
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  const resourceTemplates = [
    {
      uriTemplate: "erpnext://{doctype}/{name}",
      name: "ERPNext Document",
      mimeType: "application/json",
      description: "Fetch an ERPNext document by doctype and name"
    }
  ];

  return { resourceTemplates };
});

/**
 * Handler for reading ERPNext resources.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (!erpnext.isAuthenticated()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Not authenticated with ERPNext. Please configure API key authentication."
    );
  }

  const uri = request.params.uri;
  let result: any;

  // Handle special resource: erpnext://DocTypes (list of all doctypes)
  if (uri === "erpnext://DocTypes") {
    try {
      const doctypes = await erpnext.getAllDocTypes();
      result = { doctypes };
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch DocTypes: ${error?.message || 'Unknown error'}`
      );
    }
  } else {
    // Handle document access: erpnext://{doctype}/{name}
    const documentMatch = uri.match(/^erpnext:\/\/([^\/]+)\/(.+)$/);
    if (documentMatch) {
      const doctype = decodeURIComponent(documentMatch[1]);
      const name = decodeURIComponent(documentMatch[2]);
      
      try {
        result = await erpnext.getDocument(doctype, name);
      } catch (error: any) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Failed to fetch ${doctype} ${name}: ${error?.message || 'Unknown error'}`
        );
      }
    }
  }

  if (!result) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Invalid ERPNext resource URI: ${uri}`
    );
  }

  return {
    contents: [{
      uri: request.params.uri,
      mimeType: "application/json",
      text: JSON.stringify(result, null, 2)
    }]
  };
});

/**
 * Handler that lists available tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
      {
        name: "get_doctypes",
        description: "Get a list of all available DocTypes",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "get_doctype_fields",
        description: "Get fields list for a specific DocType",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Customer, Item)"
            }
          },
            required: ["doctype"]
        }
      },
      {
        name: "get_documents",
        description: "Get a list of documents for a specific doctype",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Customer, Item)"
            },
            fields: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Fields to include (optional)"
            },
            filters: {
              oneOf: [
                {
                  type: "array",
                  items: {
                    type: "array",
                    minItems: 3,
                    maxItems: 3,
                    items: {}
                  }
                },
                {
                  type: "object",
                  additionalProperties: true
                }
              ],
              description: "Frappe filters as [field, operator, value] tuples; simple {field: value} objects are also accepted."
            },
            or_filters: {
              type: "array",
              description: "Optional OR filters as [field, operator, value] tuples.",
              items: { type: "array", minItems: 3, maxItems: 3, items: {} }
            },
            limit_start: {
              type: "integer",
              minimum: 0,
              description: "Number of records to skip (optional)"
            },
            order_by: {
              type: "string",
              description: "Sort expression, for example modified desc (optional)"
            },
            expand: {
              type: "array",
              items: { type: "string" },
              description: "Link fields to expand (optional)"
            },
            limit: {
              type: "number",
              description: "Maximum number of documents to return (optional)"
            }
          },
          required: ["doctype"]
        }
      },
      {
        name: "create_document",
        description: "Create a new document in ERPNext",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Customer, Item)"
            },
            data: {
              type: "object",
              additionalProperties: true,
              description: "Document data"
            },
            verbose: {
              type: "boolean",
              description: "If true, return the full document in the response. Default is false (returns minimal confirmation only)."
            }
          },
          required: ["doctype", "data"]
        }
      },
      {
        name: "update_document",
        description: "Update an existing document in ERPNext",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Customer, Item)"
            },
            name: {
              type: "string",
              description: "Document name/ID"
            },
            data: {
              type: "object",
              additionalProperties: true,
              description: "Document data to update"
            },
            verbose: {
              type: "boolean",
              description: "If true, return the full document in the response. Default is false (returns minimal confirmation only)."
            }
          },
          required: ["doctype", "name", "data"]
        }
      },
      {
        name: "run_report",
        description: "Run an ERPNext report",
        inputSchema: {
          type: "object",
          properties: {
            report_name: {
              type: "string",
              description: "Name of the report"
            },
            filters: {
              type: "object",
              additionalProperties: true,
              description: "Report filters (optional)"
            }
          },
          required: ["report_name"]
        }
      },
      {
        name: "get_document",
        description: "Get a single document by DocType and name, including all child tables and linked data",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Customer, Sales Order, BOM)"
            },
            name: {
              type: "string",
              description: "Document name/ID"
            }
          },
          required: ["doctype", "name"]
        }
      },
      {
        name: "call_method",
        description: "Call an ERPNext/Frappe whitelisted server-side API method. Can invoke any whitelisted method — use with caution. Args are passed as JSON body (POST) or query params (GET).",
        inputSchema: {
          type: "object",
          properties: {
            method: {
              type: "string",
              description: "Dotted method path (e.g., frappe.client.get_count, erpnext.manufacturing.doctype.work_order.work_order.make_stock_entry)"
            },
            args: {
              type: "object",
              additionalProperties: true,
              description: "Method arguments as key-value pairs (optional)"
            },
            http_method: {
              type: "string",
              enum: ["GET", "POST"],
              description: "HTTP method to use (default: POST). Use GET for read-only methods."
            }
          },
          required: ["method"]
        }
      },
      {
        name: "submit_document",
        description: "Submit a document (set docstatus to 1). Only works on submittable doctypes. Submitted documents can only be cancelled, not reverted to draft.",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType (e.g., Sales Invoice, Journal Entry)"
            },
            name: {
              type: "string",
              description: "Document name/ID"
            },
            verbose: {
              type: "boolean",
              description: "If true, return the full document in the response. Default is false (returns minimal confirmation only)."
            }
          },
          required: ["doctype", "name"]
        }
      },
      {
        name: "cancel_document",
        description: "Cancel a submitted document (set docstatus to 2). Cancelled documents cannot be modified — use amend workflow to create a corrected copy.",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType"
            },
            name: {
              type: "string",
              description: "Document name/ID"
            },
            verbose: {
              type: "boolean",
              description: "If true, return the full document in the response. Default is false (returns minimal confirmation only)."
            }
          },
          required: ["doctype", "name"]
        }
      },
      {
        name: "delete_document",
        description: "Permanently delete a document from ERPNext. This action cannot be undone. Submitted documents must be cancelled before deletion.",
        inputSchema: {
          type: "object",
          properties: {
            doctype: {
              type: "string",
              description: "ERPNext DocType"
            },
            name: {
              type: "string",
              description: "Document name/ID"
            }
          },
          required: ["doctype", "name"]
        }
      }
  ];

  const readOnlyTools = new Set([
    "get_doctypes",
    "get_doctype_fields",
    "get_documents",
    "run_report",
    "get_document"
  ]);
  const destructiveTools = new Set([
    "call_method",
    "update_document",
    "submit_document",
    "cancel_document",
    "delete_document"
  ]);

  return {
    tools: tools.map(tool => ({
      ...tool,
      annotations: {
        readOnlyHint: readOnlyTools.has(tool.name),
        destructiveHint: destructiveTools.has(tool.name),
        idempotentHint: readOnlyTools.has(tool.name) || tool.name === "update_document" || tool.name === "cancel_document",
        openWorldHint: true
      },
      outputSchema: {
        type: "object",
        properties: { data: {} },
        required: ["data"]
      }
    }))
  };
});

/**
 * Handler for tool calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!erpnext.isAuthenticated()) {
    return {
      content: [{
        type: "text",
        text: "Not authenticated with ERPNext. Please configure API key authentication."
      }],
      isError: true
    };
  }

  switch (request.params.name) {
    case "get_documents": {
      const doctype = requiredString(request.params.arguments, "doctype");
      const fields = request.params.arguments?.fields as string[] | undefined;
      const filters = parseFilterInput(request.params.arguments?.filters);
      const orFilters = parseFilterInput(request.params.arguments?.or_filters);
      const limit = request.params.arguments?.limit as number | undefined;
      const limitStart = request.params.arguments?.limit_start as number | undefined;
      const orderBy = request.params.arguments?.order_by as string | undefined;
      const expand = request.params.arguments?.expand as string[] | undefined;
      
      try {
        const documents = await erpnext.getDocList(doctype, {
          filters,
          orFilters,
          fields,
          limit,
          limitStart,
          orderBy,
          expand
        });
        return jsonResult(documents);
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to get ${doctype} documents: ${error?.message || 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
    
    case "create_document": {
      const doctype = requiredString(request.params.arguments, "doctype");
      const data = request.params.arguments?.data as Record<string, any> | undefined;
      const verbose = request.params.arguments?.verbose === true;
      
      if (!isRecord(data)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Doctype and data are required"
        );
      }
      
      try {
        const result = await erpnext.createDocument(doctype, data);
        if (verbose) {
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "success",
            doctype: doctype,
            name: result.name,
            docstatus: result.docstatus
          }) }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to create ${doctype}: ${error?.message || 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
    
    case "update_document": {
      const doctype = requiredString(request.params.arguments, "doctype");
      const name = requiredString(request.params.arguments, "name");
      const data = request.params.arguments?.data as Record<string, any> | undefined;
      const verbose = request.params.arguments?.verbose === true;
      
      if (!isRecord(data)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Doctype, name, and data are required"
        );
      }
      
      try {
        const result = await erpnext.updateDocument(doctype, name, data);
        if (verbose) {
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "success",
            doctype: doctype,
            name: result.name,
            docstatus: result.docstatus
          }) }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to update ${doctype} ${name}: ${error?.message || 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
    
    case "run_report": {
      const reportName = requiredString(request.params.arguments, "report_name");
      const filters = request.params.arguments?.filters as Record<string, any> | undefined;
      
      try {
        const result = await erpnext.runReport(reportName, filters);
        return jsonResult(result);
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to run report ${reportName}: ${error?.message || 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
    
    case "get_document": {
      const doctype = requiredString(request.params.arguments, "doctype");
      const name = requiredString(request.params.arguments, "name");
      
      try {
        const document = await erpnext.getDocument(doctype, name);
        return jsonResult(document);
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to get ${doctype} ${name}: ${error?.message || 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
    
    case "call_method": {
      const method = requiredString(request.params.arguments, "method");
      const args = request.params.arguments?.args as Record<string, any> | undefined;
      const httpMethod = (request.params.arguments?.http_method as "GET" | "POST") || "POST";
      
      try {
        const result = await erpnext.callMethod(method, args, httpMethod);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to call method ${method}: ${error?.message || 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
    
    case "submit_document": {
      const doctype = requiredString(request.params.arguments, "doctype");
      const name = requiredString(request.params.arguments, "name");
      const verbose = request.params.arguments?.verbose === true;
      
      try {
        // frappe.client.submit constructs the doc from the passed dict rather
        // than loading from DB, so it needs the full document with all fields.
        const fullDoc = await erpnext.getDocument(doctype, name);
        const result = await erpnext.callMethod('frappe.client.submit', { doc: fullDoc });
        if (verbose) {
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
          };
        }
        if (!result || typeof result !== "object" || result.name == null || result.docstatus == null) {
          throw new McpError(
            ErrorCode.InternalError,
            `Unexpected response from ERPNext while submitting ${doctype} ${name}`
          );
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "success",
            doctype: doctype,
            name: result.name,
            docstatus: result.docstatus
          }) }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to submit ${doctype} ${name}: ${error?.message || 'Unknown error'}`
          }],
          isError: true
        };
      }
    }

    case "cancel_document": {
      const doctype = requiredString(request.params.arguments, "doctype");
      const name = requiredString(request.params.arguments, "name");
      const verbose = request.params.arguments?.verbose === true;
      
      try {
        const result = await erpnext.callMethod('frappe.client.cancel', { doctype, name });
        if (verbose) {
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
          };
        }
        if (!result || typeof result !== "object" || result.name == null || result.docstatus == null) {
          throw new McpError(
            ErrorCode.InternalError,
            `Unexpected response from ERPNext while cancelling ${doctype} ${name}`
          );
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "success",
            doctype: doctype,
            name: result.name,
            docstatus: result.docstatus
          }) }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to cancel ${doctype} ${name}: ${error?.message || 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
    
    case "delete_document": {
      const doctype = requiredString(request.params.arguments, "doctype");
      const name = requiredString(request.params.arguments, "name");

      try {
        await erpnext.deleteDocument(doctype, name);
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "success",
            action: "deleted",
            doctype: doctype,
            name: name
          }) }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to delete ${doctype} ${name}: ${error?.message || 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
    
    case "get_doctype_fields": {
      const doctype = requiredString(request.params.arguments, "doctype");
      
      try {
        const metadata = await erpnext.getDocTypeMeta(doctype);
        return jsonResult(metadata);
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to get fields for ${doctype}: ${error?.message || 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
    
    case "get_doctypes": {
      try {
        const doctypes = await erpnext.getAllDocTypes();
        return jsonResult(doctypes);
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Failed to get DocTypes: ${error?.message || 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
      
    default:
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${request.params.name}`
      );
  }
});

/**
 * Start the server using stdio transport.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ERPNext MCP server running on stdio');
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
