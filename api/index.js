// GoHighLevel MCP Server v2.0 — Full API Integration
// Built for Claude/Cowork via Vercel serverless
// Expanded: Messages, Workflows, Notes, Tasks, Calendar, Pagination, Custom Fields

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'ghl-mcp-server', version: '2.0.0' };

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
// Organized by priority tier: Original (v1) → P0 (Messages) → P1 (Workflows/Notes/Tasks) → P2 (Calendar) → P3 (Pagination/Advanced)

const TOOLS = [

  // ═══════════════════════════════════════════════════════════════════════════
  // ORIGINAL v1 TOOLS (16 tools — unchanged)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'get_location',
    description: 'Get sub-account details, settings, and configuration',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'search_contacts',
    description: 'Search contacts by name, email, phone, or tag. Returns max 25 results. For paginated results use search_contacts_paginated.',
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
    description: 'Get full details of a specific contact by ID, including custom field values',
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
        source: { type: 'string' },
        customFields: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, field_value: { type: 'string' } } }, description: 'Custom field values as [{key, field_value}]' }
      }
    }
  },
  {
    name: 'update_contact',
    description: 'Update an existing contact. Can update name, email, phone, tags, and custom fields.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        customFields: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, field_value: { type: 'string' } } }, description: 'Custom field values as [{key, field_value}]' }
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
    description: 'Search pipeline opportunities. Filter by pipeline, stage, or query. Max 100 results. For paginated results use search_opportunities_paginated.',
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
    description: 'Search conversations (metadata). Use get_messages to read actual message content.',
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
    description: 'Send an SMS message to a contact. Auto-creates conversation if needed.',
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
    description: 'Get all automation workflows in this sub-account (names and IDs)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_location_custom_fields',
    description: 'Get all custom fields defined for this location (field names, keys, types)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_location_tags',
    description: 'Get all contact tags used in this location',
    inputSchema: { type: 'object', properties: {} }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // P0 — MESSAGES & COMMUNICATION (unlocks conversation visibility + email)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'get_messages',
    description: 'Get actual message content for a conversation. Returns SMS, email, and other message bodies with timestamps and direction (inbound/outbound).',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation ID (get from search_conversations)' },
        limit: { type: 'number', description: 'Max messages to return (default 50)' },
        type: { type: 'string', description: 'Filter by message type: SMS, Email, etc. (optional)' }
      },
      required: ['conversationId']
    }
  },
  {
    name: 'send_email',
    description: 'Send an email to a contact via GHL. Auto-creates conversation if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'Contact ID to email' },
        subject: { type: 'string', description: 'Email subject line' },
        message: { type: 'string', description: 'Email body (HTML supported)' },
        emailFrom: { type: 'string', description: 'From name (optional, uses default if omitted)' }
      },
      required: ['contactId', 'subject', 'message']
    }
  },
  {
    name: 'send_message',
    description: 'Send a message via any channel (SMS, Email, WhatsApp, etc.) to an existing conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Existing conversation ID' },
        type: { type: 'string', enum: ['SMS', 'Email', 'WhatsApp', 'GMB', 'IG', 'FB', 'Live_Chat', 'Custom'], description: 'Message channel type' },
        message: { type: 'string', description: 'Message body' },
        subject: { type: 'string', description: 'Subject line (required for Email type)' },
        html: { type: 'string', description: 'HTML body for emails (optional, overrides message for email)' }
      },
      required: ['conversationId', 'type', 'message']
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // P1 — WORKFLOW AUTOMATION & CONTACT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'add_contact_to_workflow',
    description: 'Enroll a contact into a GHL automation workflow. Use ghl_get_workflows to find workflow IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        workflowId: { type: 'string' }
      },
      required: ['contactId', 'workflowId']
    }
  },
  {
    name: 'remove_contact_from_workflow',
    description: 'Remove a contact from a GHL automation workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        workflowId: { type: 'string' }
      },
      required: ['contactId', 'workflowId']
    }
  },
  {
    name: 'remove_contact_tags',
    description: 'Remove one or more tags from a contact',
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
    name: 'delete_contact',
    description: 'Permanently delete a contact. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: { contactId: { type: 'string' } },
      required: ['contactId']
    }
  },
  {
    name: 'get_contact_notes',
    description: 'Get all notes on a contact',
    inputSchema: {
      type: 'object',
      properties: { contactId: { type: 'string' } },
      required: ['contactId']
    }
  },
  {
    name: 'create_contact_note',
    description: 'Add a note to a contact',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        body: { type: 'string', description: 'Note text content' }
      },
      required: ['contactId', 'body']
    }
  },
  {
    name: 'get_contact_tasks',
    description: 'Get all tasks for a contact',
    inputSchema: {
      type: 'object',
      properties: { contactId: { type: 'string' } },
      required: ['contactId']
    }
  },
  {
    name: 'create_contact_task',
    description: 'Create a task on a contact (follow-up, to-do, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task details (optional)' },
        dueDate: { type: 'string', description: 'Due date in ISO 8601 format (optional)' },
        assignedTo: { type: 'string', description: 'User ID to assign task to (optional)' }
      },
      required: ['contactId', 'title']
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // P2 — CALENDAR & APPOINTMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'get_calendars',
    description: 'List all calendars (booking calendars) in this sub-account',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_calendar_appointments',
    description: 'List appointments for a specific calendar within a date range',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
        startDate: { type: 'string', description: 'Start date (ISO 8601, e.g. 2026-03-01)' },
        endDate: { type: 'string', description: 'End date (ISO 8601, e.g. 2026-03-31)' }
      },
      required: ['calendarId', 'startDate', 'endDate']
    }
  },
  {
    name: 'get_appointment',
    description: 'Get details of a specific appointment by ID',
    inputSchema: {
      type: 'object',
      properties: { appointmentId: { type: 'string' } },
      required: ['appointmentId']
    }
  },
  {
    name: 'create_appointment',
    description: 'Book an appointment on a GHL calendar',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
        contactId: { type: 'string' },
        startTime: { type: 'string', description: 'Start time (ISO 8601)' },
        endTime: { type: 'string', description: 'End time (ISO 8601)' },
        title: { type: 'string' },
        notes: { type: 'string', description: 'Appointment notes (optional)' },
        status: { type: 'string', enum: ['confirmed', 'cancelled', 'showed', 'noshow', 'invalid'], description: 'Appointment status (default: confirmed)' }
      },
      required: ['calendarId', 'contactId', 'startTime', 'endTime', 'title']
    }
  },
  {
    name: 'update_appointment',
    description: 'Update an existing appointment (reschedule, change status, add notes)',
    inputSchema: {
      type: 'object',
      properties: {
        appointmentId: { type: 'string' },
        startTime: { type: 'string', description: 'New start time (ISO 8601)' },
        endTime: { type: 'string', description: 'New end time (ISO 8601)' },
        title: { type: 'string' },
        notes: { type: 'string' },
        status: { type: 'string', enum: ['confirmed', 'cancelled', 'showed', 'noshow', 'invalid'] }
      },
      required: ['appointmentId']
    }
  },
  {
    name: 'get_contact_appointments',
    description: 'Get all appointments for a specific contact',
    inputSchema: {
      type: 'object',
      properties: { contactId: { type: 'string' } },
      required: ['contactId']
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // P3 — PAGINATION & ADVANCED
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'search_contacts_paginated',
    description: 'Search contacts with cursor-based pagination. Use startAfterId from previous response to get next page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (optional for browsing all)' },
        limit: { type: 'number', description: 'Results per page (max 100, default 100)' },
        startAfterId: { type: 'string', description: 'Cursor — last contact ID from previous page' }
      }
    }
  },
  {
    name: 'search_opportunities_paginated',
    description: 'Search opportunities with cursor-based pagination. Use startAfterId from previous response to get next page.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Filter by pipeline ID (optional)' },
        stageId: { type: 'string', description: 'Filter by stage ID (optional)' },
        query: { type: 'string', description: 'Search term (optional)' },
        status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'] },
        limit: { type: 'number', description: 'Results per page (max 100, default 100)' },
        startAfterId: { type: 'string', description: 'Cursor — last opportunity ID from previous page' }
      }
    }
  },
  {
    name: 'update_custom_field_values',
    description: 'Set custom field values on a contact. Get field keys from get_location_custom_fields first.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        customFields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Custom field key (from get_location_custom_fields)' },
              field_value: { type: 'string', description: 'Value to set' }
            }
          },
          description: 'Array of {key, field_value} objects'
        }
      },
      required: ['contactId', 'customFields']
    }
  },
  {
    name: 'get_forms',
    description: 'List all forms in this sub-account',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_form_submissions',
    description: 'Get submissions for a specific form',
    inputSchema: {
      type: 'object',
      properties: {
        formId: { type: 'string' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        startAfterId: { type: 'string', description: 'Cursor for pagination (optional)' }
      },
      required: ['formId']
    }
  }
];

// ─── Tool Execution ───────────────────────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {

    // ── Original v1 tools ──────────────────────────────────────────────────

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
        type: 'SMS', conversationId, contactId: args.contactId, message: args.message
      });
    }

    case 'ghl_get_workflows':
      return ghlRequest(`/workflows/?locationId=${GHL_LOCATION_ID}`);

    case 'get_location_custom_fields':
      return ghlRequest(`/locations/${GHL_LOCATION_ID}/customFields`);

    case 'get_location_tags':
      return ghlRequest(`/locations/${GHL_LOCATION_ID}/tags`);

    // ── P0: Messages & Communication ────────────────────────────────────────

    case 'get_messages': {
      let url = `/conversations/${args.conversationId}/messages?limit=${args.limit || 50}`;
      if (args.type) url += `&type=${args.type}`;
      return ghlRequest(url);
    }

    case 'send_email': {
      // Look up contact to get email address (GHL requires emailTo explicitly)
      const contact = await ghlRequest(`/contacts/${args.contactId}`);
      const emailTo = contact?.contact?.email || contact?.email;
      if (!emailTo) throw new Error('Contact has no email address on file');
      // Find or create conversation
      const convSearch = await ghlRequest(`/conversations/search?locationId=${GHL_LOCATION_ID}&contactId=${args.contactId}`);
      let conversationId = convSearch.conversations?.[0]?.id;
      if (!conversationId) {
        const newConv = await ghlRequest('/conversations/', 'POST', {
          locationId: GHL_LOCATION_ID, contactId: args.contactId
        });
        conversationId = newConv.conversation?.id || newConv.id;
      }
      const payload = {
        type: 'Email',
        conversationId,
        contactId: args.contactId,
        emailTo,
        html: args.html || args.message,
        subject: args.subject
      };
      if (args.emailFrom) payload.emailFrom = args.emailFrom;
      return ghlRequest('/conversations/messages', 'POST', payload);
    }

    case 'send_message': {
      // Look up conversation to get contactId (required by GHL for email sends)
      const conv = await ghlRequest(`/conversations/${args.conversationId}`);
      const convContactId = conv?.conversation?.contactId || conv?.contactId;
      const payload = {
        type: args.type,
        conversationId: args.conversationId,
        message: args.message
      };
      if (convContactId) payload.contactId = convContactId;
      if (args.type === 'Email') {
        // GHL requires html field for email body, not message
        payload.html = args.html || args.message;
        if (convContactId) {
          const convContact = await ghlRequest(`/contacts/${convContactId}`);
          const emailAddr = convContact?.contact?.email || convContact?.email;
          if (emailAddr) payload.emailTo = emailAddr;
        }
      } else if (args.html) {
        payload.html = args.html;
      }
      if (args.subject) payload.subject = args.subject;
      return ghlRequest('/conversations/messages', 'POST', payload);
    }

    // ── P1: Workflow & Contact Management ────────────────────────────────────

    case 'add_contact_to_workflow':
      return ghlRequest(`/contacts/${args.contactId}/workflow/${args.workflowId}`, 'POST');

    case 'remove_contact_from_workflow':
      return ghlRequest(`/contacts/${args.contactId}/workflow/${args.workflowId}`, 'DELETE');

    case 'remove_contact_tags':
      return ghlRequest(`/contacts/${args.contactId}/tags`, 'DELETE', { tags: args.tags });

    case 'delete_contact':
      return ghlRequest(`/contacts/${args.contactId}`, 'DELETE');

    case 'get_contact_notes':
      return ghlRequest(`/contacts/${args.contactId}/notes`);

    case 'create_contact_note':
      return ghlRequest(`/contacts/${args.contactId}/notes`, 'POST', { body: args.body });

    case 'get_contact_tasks':
      return ghlRequest(`/contacts/${args.contactId}/tasks`);

    case 'create_contact_task': {
      const taskPayload = { title: args.title, completed: false };
      if (args.description) taskPayload.body = args.description;
      if (args.dueDate) taskPayload.dueDate = args.dueDate;
      if (args.assignedTo) taskPayload.assignedTo = args.assignedTo;
      return ghlRequest(`/contacts/${args.contactId}/tasks`, 'POST', taskPayload);
    }

    // ── P2: Calendar & Appointments ─────────────────────────────────────────

    case 'get_calendars':
      return ghlRequest(`/calendars/?locationId=${GHL_LOCATION_ID}`);

    case 'get_calendar_appointments': {
      // GHL v2 uses /calendars/events with epoch timestamps
      const startEpoch = new Date(args.startDate).getTime();
      const endEpoch = new Date(args.endDate).getTime();
      let url = `/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${args.calendarId}`;
      url += `&startTime=${startEpoch}&endTime=${endEpoch}`;
      return ghlRequest(url);
    }

    case 'get_appointment':
      return ghlRequest(`/calendars/events/appointments/${args.appointmentId}`);

    case 'create_appointment': {
      const apptPayload = {
        calendarId: args.calendarId,
        locationId: GHL_LOCATION_ID,
        contactId: args.contactId,
        startTime: args.startTime,
        endTime: args.endTime,
        title: args.title,
        status: args.status || 'confirmed'
      };
      if (args.notes) apptPayload.notes = args.notes;
      return ghlRequest('/calendars/events/appointments', 'POST', apptPayload);
    }

    case 'update_appointment': {
      const { appointmentId, ...apptData } = args;
      return ghlRequest(`/calendars/events/appointments/${appointmentId}`, 'PUT', apptData);
    }

    case 'get_contact_appointments':
      return ghlRequest(`/contacts/${args.contactId}/appointments`);

    // ── P3: Pagination & Advanced ───────────────────────────────────────────

    case 'search_contacts_paginated': {
      let url = `/contacts/?locationId=${GHL_LOCATION_ID}&limit=${args.limit || 100}`;
      if (args.query) url += `&query=${encodeURIComponent(args.query)}`;
      if (args.startAfterId) url += `&startAfterId=${args.startAfterId}`;
      return ghlRequest(url);
    }

    case 'search_opportunities_paginated': {
      let url = `/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=${args.limit || 100}`;
      if (args.pipelineId) url += `&pipeline_id=${args.pipelineId}`;
      if (args.stageId) url += `&pipeline_stage_id=${args.stageId}`;
      if (args.query) url += `&q=${encodeURIComponent(args.query)}`;
      if (args.status) url += `&status=${args.status}`;
      if (args.startAfterId) url += `&startAfterId=${args.startAfterId}`;
      return ghlRequest(url);
    }

    case 'update_custom_field_values': {
      return ghlRequest(`/contacts/${args.contactId}`, 'PUT', {
        customFields: args.customFields
      });
    }

    case 'get_forms':
      return ghlRequest(`/forms/?locationId=${GHL_LOCATION_ID}`);

    case 'get_form_submissions': {
      let url = `/forms/submissions?locationId=${GHL_LOCATION_ID}&formId=${args.formId}&limit=${args.limit || 50}`;
      if (args.startAfterId) url += `&startAfterId=${args.startAfterId}`;
      return ghlRequest(url);
    }

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
      toolGroups: {
        original: 16,
        p0_messages: 3,
        p1_workflows: 8,
        p2_calendar: 6,
        p3_advanced: 5
      },
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
            const { name, arguments: toolArgs } = params;
            try {
              const result = await executeTool(name, toolArgs || {});
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
