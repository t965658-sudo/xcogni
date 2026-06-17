# ChatGPT-Style Token Streaming Implementation

## Overview

This document describes the Server-Sent Events (SSE) streaming implementation for real-time token-by-token AI response generation in CognisysAI.

## Features Implemented

✅ **Token-by-token generation** - Real-time streaming of AI responses  
✅ **Stop generating button** - User can interrupt generation at any time  
✅ **AbortController support** - Proper request cancellation and cleanup  
✅ **Connection recovery** - Graceful error handling and reconnection support  
✅ **Typing indicator** - Visual feedback during streaming  
✅ **Partial message rendering** - Live markdown rendering as tokens arrive  
✅ **Final message persistence** - Complete response saved to database after stream completion  

## Architecture

### Backend Components

#### 1. `services/aiRouter.js`

**New Functions:**

```javascript
// Async generator for Hugging Face streaming API
async function* hfStreamRequest(model, messages, maxTokens)

// Stream AI response with token callback
async function streamAIResponse(message, history, onToken, abortSignal)

// Stream from specific model
async function streamModel(model, message, history, onToken, abortSignal)
```

**Key Features:**
- Parses SSE format (`data: {...}`) from Hugging Face API
- Yields tokens as async generator
- Supports AbortSignal for cancellation
- Maintains fallback model chain (Llama → Qwen → Mistral)

#### 2. `routes/chat.js`

**New Endpoint:** `POST /api/chat/stream`

**Headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

**SSE Message Format:**

Token events:
```javascript
data: {"type":"token","token":"Hello"}
```

Completion event:
```javascript
data: {"type":"done","reply":"Full response","model":"meta-llama/Llama-3.1-8B-Instruct","conversation_id":123,"message_id":456}
```

Error event:
```javascript
data: {"type":"error","error":"Error message"}
```

**AbortController Integration:**
```javascript
const abortController = new AbortController();
req.on('close', () => abortController.abort());
req.on('error', () => abortController.abort());
```

### Frontend Components

#### `public/index.html`

**Global State:**
```javascript
let currentStreamController = null;
```

**Streaming Function:**
```javascript
async function sendMessage() {
  currentStreamController = new AbortController();
  
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    signal: currentStreamController.signal,
    // ...headers and body
  });
  
  const reader = response.body.getReader();
  // Read and process SSE events
}
```

**Stop Generation:**
```javascript
function stopGeneration() {
  if (currentStreamController) {
    currentStreamController.abort();
  }
}
```

**UI Updates:**
- Send button disabled during streaming
- Red stop button appears during streaming
- Partial content rendered in real-time with DOMPurify sanitization
- Typing indicator shown via streaming message state

## Data Flow

```
User sends message
    ↓
Frontend creates AbortController
    ↓
POST /api/chat/stream (with signal)
    ↓
Backend stores user message in DB
    ↓
Backend calls streamAIResponse()
    ↓
Hugging Face streams tokens
    ↓
Backend sends SSE: data: {"type":"token","token":"..."}
    ↓
Frontend receives token, updates UI
    ↓
[Repeat for each token...]
    ↓
Stream completes
    ↓
Backend saves full response to DB
    ↓
Backend sends: data: {"type":"done",...}
    ↓
Frontend finalizes message, loads conversations
```

## Error Handling

### Client Disconnect
- `req.on('close')` triggers AbortController
- Stream stops immediately
- Partial content preserved

### API Errors
- SSE error event sent to client
- Frontend displays error message
- No incomplete message saved to DB

### Network Issues
- Fetch promise rejects
- Frontend catches error
- User sees error toast

## Security Considerations

1. **Authentication**: Bearer token required for all requests
2. **Input Validation**: Message length limits enforced (4000 chars)
3. **XSS Prevention**: All rendered content sanitized with DOMPurify
4. **Rate Limiting**: Express rate limiter applies to streaming endpoint
5. **CORS**: Configured with credentials support

## Browser Compatibility

Server-Sent Events supported in:
- ✅ Chrome/Edge (all recent versions)
- ✅ Firefox (all recent versions)
- ✅ Safari (all recent versions)
- ❌ Internet Explorer (not supported)

## Usage Example

### JavaScript Client

```javascript
const controller = new AbortController();

const response = await fetch('/api/chat/stream', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    message: 'Explain quantum computing',
    conversation_id: 123
  }),
  signal: controller.signal
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const text = decoder.decode(value);
  const lines = text.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      
      if (data.type === 'token') {
        console.log('Received token:', data.token);
      } else if (data.type === 'done') {
        console.log('Complete:', data.reply);
      }
    }
  }
}

// To stop generation:
controller.abort();
```

## Migration Notes

### Backward Compatibility

The original `/api/chat` endpoint remains unchanged for clients that don't support streaming.

### Database Schema

No schema changes required. Messages are saved after stream completion as before.

### Environment Variables

No new environment variables needed. Uses existing `HF_TOKEN`.

## Performance Optimizations

1. **Chunked Transfer**: Response sent immediately, no buffering
2. **Efficient Parsing**: Line-by-line SSE parsing with buffer management
3. **Minimal Overhead**: Only token delta transmitted, not full state
4. **Connection Reuse**: HTTP keep-alive enabled

## Testing Checklist

- [ ] Token streaming works with primary model (Llama)
- [ ] Fallback to Qwen when Llama unavailable
- [ ] Fallback to Mistral when Qwen unavailable
- [ ] Stop button interrupts generation
- [ ] Partial messages displayed correctly
- [ ] Full message persisted to database
- [ ] Error states handled gracefully
- [ ] Client disconnect cancels stream
- [ ] XSS prevention still active
- [ ] Rate limiting applies correctly
- [ ] Mobile UI shows stop button properly

## Future Enhancements

1. **Reconnection Logic**: Automatic resume on connection loss
2. **Progress Tracking**: Token count / estimated time remaining
3. **Multiple Concurrent Streams**: Support for parallel conversations
4. **WebSocket Alternative**: For bidirectional communication needs
5. **Typing Speed Control**: Adjustable token display rate

## Troubleshooting

### Stream Not Working
- Check browser DevTools Network tab for SSE connection
- Verify `Content-Type: text/event-stream` header
- Ensure no proxy buffering SSE responses

### Stop Button Not Responding
- Check AbortController is properly linked to fetch request
- Verify `req.on('close')` handler is registered

### Tokens Arriving Slowly
- Check Hugging Face API status
- Verify network latency
- Consider using dedicated inference endpoints

---

**Implementation Date**: 2026-06-17  
**Version**: 2.1.0  
**Author**: CognisysAI Development Team
