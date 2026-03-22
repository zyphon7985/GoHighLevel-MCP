// GoHighLevel MCP Server — Real API Integration
// Built for Claude/Cowork via Vercel serverless

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'ghl-mcp-server', version: '1.0.0' };

// ─── GHL API Helper ───────────────────────────────────────────────────────────

async function ghlRequest(endpoint, method = 'GET', body = null) {
  const url = `${GHL_BASE_URL}${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${GHL_API_KEY}`,
    'Version': GHL_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`GHL API ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_location',
    description: 'Get sub-account details, settings, and configuration',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'search_contacts',
    description: 'Search contacts by name, email, phone, or tag',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term' },
        limit: { type: 'number', description: 'Max results (default 25)' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_contact',
    description: 'Get full details of a specific contact by ID',
    inputSchema: {
      type: 'object',
      properties: { contactId: { type: 'string' } },
      required: ['contactId']
    }
  },
  {
    name: 'create_contact',
    description: 'Create a new contact in GoHighLevel',
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        source: { type: 'string' }
      }
    }
  },
  {
    name: 'update_contact',
    description: 'Update an existing contact',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['contactId']
    }
  },
  {
    name: 'add_contact_tags',
    description: 'Add one or more tags to a contact',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['contactId', 'tags']
    }
  },
  {
    name: 'get_pipelines',
    description: 'Get all sales pipelines and their stages',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'search_opportunities',
    description: 'Search pipeline opportunities. Filter by pipeline, stage, or query.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Filter by pipeline ID (optional)' },
        stageId: { type: 'string', description: 'Filter by stage ID (optional)' },
        query: { type: 'string', description: 'Search term (optional)' },
        status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'] },
        limit: { type: 'number', description: 'Max results (default 25)' }
      }
    }
  },
  {
    name: 'get_opportunity',
    description: 'Get a specific opportunity by ID',
    inputSchema: {
      type: 'object',
      properties: { opportunityId: { type: 'string' } },
      required: ['opportunityId']
    }
  },
  {
    name: 'create_opportunity',
    description: 'Create a new deal/opportunity in a pipeline',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string' },
        pipelineStageId: { type: 'string' },
        contactId: { type: 'string' },
        name: { type: 'string' },
        monetaryValue: { type: 'number' },
        status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'] }
      },
      required: ['pipelineId', 'contactId', 'name']
    }
  },
  {
    name: 'update_opportunity',
    description: 'Update an opportunity — move stage, change status, update value',
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string' },
        pipelineStageId: { type: 'string', description: 'New stage ID' },
        status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'] },
        monetaryValue: { type: 'number' },
        name: { type: 'string' }
      },
      required: ['opportunityId']
    }
  },
  {
    name: 'search_conversations',
    description: 'Search conversations and messages',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'Filter by contact ID (optional)' },
        limit: { type: 'number', description: 'Max results (default 20)' }
      }
    }
  },
  {
    name: 'send_sms',
    description: 'Send an SMS message to a contact',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        message: { type: 'string' }
      },
      required: ['contactId', 'message']
    }
  },
  {
    name: 'ghl_get_workflows',
    description: 'Get all automation workflows in this sub-account',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_location_custom_fields',
    description: 'Get all custom fields defined for this location',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_location_tags',
    description: 'Get all contact tags used in this location',
    inputSchema: { type: 'object', properties: {} }
  }
];

// ─── Tool Execution ───────────────────────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {
    case 'get_location':
      return ghlRequest(`/locations/${GHL_LOCATION_ID}`);
    case 'search_contacts':
      return ghlRequest(`/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(args.query)}&limit=${args.limit || 25}`);
    case 'get_contact':
      return ghlRequest(`/contacts/${args.contactId}`);
    case 'create_contact':
      return ghlRequest('/contacts/', 'POST', { ...args, locationId: GHL_LOCATION_ID });
    case 'update_contact': {
      const { contactId, ...data } = args;
      return ghlRequest(`/contacts/${contactId}`, 'PUT', data);
    }
    case 'add_contact_tags':
      return ghlRequest(`/contacts/${args.contactId}/tags`, 'POST', { tags: args.tags });
    case 'get_pipelines':
      return ghlRequest(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`);
    case 'search_opportunities': {
      let url = `/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=${args.limit || 25}`;
      if (args.pipelineId) url += `&pipeline_id=${args.pipelineId}`;
      if (args.stageId) url += `&pipeline_stage_id=${args.stageId}`;
      if (args.query) url += `&q=${encodeURIComponent(args.query)}`;
      if (args.status) url += `&status=${args.status}`;
      return ghlRequest(url);
    }
    case 'get_opportunity':
      return ghlRequest(`/opportunities/${args.opportunityId}`);
    case 'create_opportunity':
      return ghlRequest('/opportunities/', 'POST', { ...args, locationId: GHL_LOCATION_ID });
    case 'update_opportunity': {
      const { opportunityId, ...data } = args;
      return ghlRequest(`/opportunities/${opportunityId}`, 'PUT', data);
    }
    case 'search_conversations': {
      let url = `/conversations/search?locationId=${GHL_LOCATION_ID}&limit=${args.limit || 20}`;
      if (args.contactId) url += `&contactId=${args.contactId}`;
      return ghlRequest(url);
    }
    case 'send_sms': {
      const convSearch = await ghlRequest(`/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${args.contactId}`);
      let conversationId = convSearch.conversations?.[0]?.id;
      if (!conversationId) {
        const newConv = await ghlRequest('/conversations/', 'POST', {
          locationId: GHL_LOCATION_ID, contactId: args.contactId
        });
        conversationId = newConv.conversation?.id || newConv.id;
      }
      return ghlRequest('/conversations/messages', 'POST', {
        type: 'SMS', conversationId, message: args.message
      });
    }
    case 'ghl_get_workflows':
      return ghlRequest(`/workflows/?locationId=${GHL_LOCATION_ID}`);
    case 'get_location_custom_fields':
      return ghlRequest(`/locations/${GHL_LOCATION_ID}/customFields`);
    case 'get_location_tags':
      return ghlRequest(`/locations/${GHL_LOCATION_ID}/tags`);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP Helpers ──────────────────────────────────────────────────────────────

const rpcResponse = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcNotification = (method, params = {}) => ({ jsonrpc: '2.0', method, params });
const sendSSE = (res, data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id');
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const url = req.url?.split('?')[0];

  if (url === '/health' || url === '/') {
    res.status(200).json({
      status: 'healthy', server: SERVER_INFO.name, version: SERVER_INFO.version,
      protocol: MCP_PROTOCOL_VERSION, timestamp: new Date().toISOString(),
      toolCount: TOOLS.length,
      toolNames: TOOLS.map(t => t.name),
      locationId: GHL_LOCATION_ID ? GHL_LOCATION_ID.substring(0, 8) + '...' : 'NOT SET',
      apiKey: GHL_API_KEY ? 'SET (' + GHL_API_KEY.substring(0, 8) + '...)' : 'NOT SET',
      endpoint: '/sse'
    });
    return;
  }

  if (url?.includes('favicon')) { res.status(404).end(); return; }

  if (url === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id'
    });

    if (req.method === 'GET') {
      sendSSE(res, rpcNotification('notification/initialized'));
      setTimeout(() => sendSSE(res, rpcNotification('notification/tools/list_changed')), 100);
      const hb = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => clearInterval(hb));
      setTimeout(() => { clearInterval(hb); res.end(); }, 50000);
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        let message;
        try { message = JSON.parse(body); }
        catch { sendSSE(res, rpcError(null, -32700, 'Parse error')); res.end(); return; }

        const { id, method, params } = message;
        let response;

        try {
          if (method === 'initialize') {
            response = rpcResponse(id, {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: SERVER_INFO
            });
          } else if (method === 'tools/list') {
            response = rpcResponse(id, { tools: TOOLS });
          } else if (method === 'tools/call') {
            const { name, arguments: args } = params;
            try {
              const result = await executeTool(name, args || {});
              response = rpcResponse(id, {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
              });
            } catch (err) {
              response = rpcResponse(id, {
                content: [{ type: 'text', text: `GHL API Error: ${err.message}` }],
                isError: true
              });
            }
          } else if (method === 'ping') {
            response = rpcResponse(id, {});
          } else {
            response = rpcError(id, -32601, `Method not found: ${method}`);
          }
        } catch (err) {
          response = rpcError(id, -32603, `Internal error: ${err.message}`);
        }

        sendSSE(res, response);
        setTimeout(() => res.end(), 100);
      });
      return;
    }
  }

  res.status(404).json({ error: 'Not found' });
};
