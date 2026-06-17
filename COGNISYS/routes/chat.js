const express = require('express');
const router = express.Router();
const db = require('../database');
const { getAIResponse, streamAIResponse } = require('../services/aiRouter');

// Input validation helpers
const MAX_MESSAGE_LENGTH = 4000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateConversationId(id) {
  // Allow integer IDs (SQLite) or UUID format
  if (!id) return false;
  if (typeof id === 'number' || /^\d+$/.test(id)) return true;
  return UUID_REGEX.test(id);
}

function validateMessage(message) {
  if (!message || typeof message !== 'string') {
    return { valid: false, error: 'Message required' };
  }
  const trimmed = message.trim();
  if (!trimmed) return { valid: false, error: 'Message empty' };
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return { valid: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)` };
  }
  return { valid: true, value: trimmed };
}

// ─── Conversations ──────────────────────────

router.get('/conversations', async (req, res) => {
  try {
    const conversations = await db.getConversations(req.user.id);
    res.json(conversations);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

router.get('/conversations/:id', async (req, res) => {
  try {
    const conv = await db.getConversation(req.params.id, req.user.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const messages = await db.getMessages(req.params.id);
    res.json({ ...conv, messages });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

router.post('/conversations', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Title required' });
    }
    const conv = await db.createConversation(req.user.id, title.trim());
    res.json(conv);
  } catch (e) {
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

router.put('/conversations/:id', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Title required' });
    }
    if (!validateConversationId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid conversation ID' });
    }
    await db.updateConversationTitle(req.params.id, req.user.id, title.trim());
    const updated = await db.getConversation(req.params.id, req.user.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

router.patch('/conversations/:id', async (req, res) => {
  try {
    const { title } = req.body;
    if (!validateConversationId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid conversation ID' });
    }
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Title required' });
    }
    await db.updateConversationTitle(req.params.id, req.user.id, title.trim());
    res.json({ message: 'Updated' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

router.delete('/conversations/:id', async (req, res) => {
  try {
    await db.deleteConversation(req.params.id, req.user.id);
    res.json({ message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// ─── Messages ───────────────────────────────

// Standard chat endpoint (non-streaming, kept for backward compatibility)
router.post('/chat', async (req, res) => {
  try {
    const { message, conversation_id } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message required' });
    }
    const trimmed = message.trim();
    if (!trimmed) return res.status(400).json({ error: 'Message empty' });
    if (trimmed.length > 4000) return res.status(400).json({ error: 'Message too long' });

    let convId = conversation_id;
    let conv;

    if (!convId) {
      const title = trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed;
      conv = await db.createConversation(req.user.id, title);
      convId = conv.id;
    } else {
      conv = await db.getConversation(convId, req.user.id);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    }

    await db.createMessage(convId, 'user', trimmed);

    const messages = await db.getMessages(convId);
    const history = messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));

    const aiResult = await getAIResponse(trimmed, history);
    await db.createMessage(convId, 'assistant', aiResult.reply);

    res.json({
      reply: aiResult.reply,
      model: aiResult.model,
      conversation_id: convId
    });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ reply: 'CognisysAI is temporarily unavailable. Please try again.', model: 'error' });
  }
});

// Streaming chat endpoint using SSE
router.post('/chat/stream', async (req, res) => {
  const { message, conversation_id } = req.body;
  
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message required' });
  }
  const trimmed = message.trim();
  if (!trimmed) return res.status(400).json({ error: 'Message empty' });
  if (trimmed.length > 4000) return res.status(400).json({ error: 'Message too long' });

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let convId = conversation_id;
  let conv;

  try {
    if (!convId) {
      const title = trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed;
      conv = await db.createConversation(req.user.id, title);
      convId = conv.id;
    } else {
      conv = await db.getConversation(convId, req.user.id);
      if (!conv) {
        res.write(`data: ${JSON.stringify({ error: 'Conversation not found' })}\n\n`);
        return res.end();
      }
    }

    // Store user message
    await db.createMessage(convId, 'user', trimmed);

    // Get conversation history
    const messages = await db.getMessages(convId);
    const history = messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));

    // Create AbortController for handling client disconnect
    const abortController = new AbortController();
    req.on('close', () => abortController.abort());
    req.on('error', () => abortController.abort());

    // Track accumulated response
    let fullReply = '';
    let messageId = null;

    // Send tokens as they arrive
    const onToken = (token) => {
      fullReply += token;
      res.write(`data: ${JSON.stringify({ token, type: 'token' })}\n\n`);
    };

    // Stream the AI response
    const aiResult = await streamAIResponse(trimmed, history, onToken, abortController.signal);

    // Save the complete message to database
    const savedMessage = await db.createMessage(convId, 'assistant', aiResult.fullReply);
    messageId = savedMessage.id;

    // Send completion signal
    res.write(`data: ${JSON.stringify({ 
      type: 'done', 
      reply: aiResult.fullReply, 
      model: aiResult.model,
      conversation_id: convId,
      message_id: messageId
    })}\n\n`);
    res.end();

  } catch (e) {
    console.error('Stream chat error:', e);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: 'Streaming failed' });
    }
    res.write(`data: ${JSON.stringify({ 
      error: 'CognisysAI encountered an error. Please try again.', 
      type: 'error' 
    })}\n\n`);
    res.end();
  }
});

// ─── Message Edit & Regenerate ──────────────

router.patch('/messages/:id', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content required' });
    const msg = await db.updateMessage(req.params.id, content);
    res.json(msg);
  } catch (e) {
    res.status(500).json({ error: 'Failed to update message' });
  }
});

// Edit user message and regenerate assistant response
router.post('/messages/:id/edit', async (req, res) => {
  try {
    const { content } = req.body;
    const validation = validateMessage(content);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    
    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [req.params.id]);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    
    // Only allow editing user messages
    if (msg.role !== 'user') {
      return res.status(400).json({ error: 'Can only edit user messages' });
    }
    
    const conv = await db.get('SELECT * FROM conversations WHERE id = ?', [msg.conversation_id]);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    
    const messages = await db.getMessages(msg.conversation_id);
    const msgIndex = messages.findIndex(m => m.id == req.params.id);
    
    // Update the user message
    await db.updateMessage(req.params.id, validation.value);
    
    // Delete all messages after this point (including old assistant response)
    for (let i = msgIndex + 1; i < messages.length; i++) {
      await db.run('DELETE FROM messages WHERE id = ?', [messages[i].id]);
    }
    
    // Generate new assistant response
    const history = messages.slice(0, msgIndex).map(m => ({ role: m.role, content: m.content }));
    const aiResult = await getAIResponse(validation.value, history);
    const newAssistantMsg = await db.createMessage(msg.conversation_id, 'assistant', aiResult.reply);
    
    res.json({ 
      reply: aiResult.reply, 
      model: aiResult.model,
      message_id: newAssistantMsg.id 
    });
  } catch (e) {
    console.error('Edit message error:', e);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

router.post('/messages/:id/regenerate', async (req, res) => {
  try {
    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [req.params.id]);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    
    const conv = await db.get('SELECT * FROM conversations WHERE id = ?', [msg.conversation_id]);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const messages = await db.getMessages(msg.conversation_id);
    const msgIndex = messages.findIndex(m => m.id == req.params.id);
    const history = messages.slice(0, msgIndex).map(m => ({ role: m.role, content: m.content }));
    const userMsg = messages[msgIndex - 1];
    
    if (!userMsg || userMsg.role !== 'user') {
      return res.status(400).json({ error: 'Cannot regenerate' });
    }

    const aiResult = await getAIResponse(userMsg.content, history);
    await db.updateMessage(req.params.id, aiResult.reply);

    res.json({ reply: aiResult.reply, model: aiResult.model });
  } catch (e) {
    res.status(500).json({ error: 'Failed to regenerate' });
  }
});

module.exports = router;