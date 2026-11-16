/**
 * 协议层：从 SSE 帧里抽出回复正文，以及在被拦截后伪造一条合法的流。
 *
 * 为什么必须抽正文：一帧 SSE 里 JSON 骨架占的字节是正文的好几倍
 * （`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}`），
 * 直接拿原始字节去判，判定窗口实际比的是框架开销，一条很短的拒绝会因为被稀释
 * 而漏掉。抽出正文之后，代理层的窗口才和流层的窗口是同一件事。
 *
 * 为什么必须自己伪造流：拦截发生在"已经决定不放这条回复"之后，但客户端
 * 还在等后续事件。Claude Code 对不完整的事件序列会直接抛
 * "Stream ended without message_stop"，所以兜底必须补齐整条事件链。
 *
 * @module feibi-breaker-cc/sse
 */

/**
 * 从解码后的 SSE 原文里抽回复正文。
 *
 * 同时认三家：OpenAI chat（choices[].delta）、Anthropic messages（delta.text /
 * delta.thinking）、OpenAI responses（text / choices[].text）。
 *
 * @param {string} raw - 已解码的字节，可能带半截帧。
 * @returns {string} 抽出的正文。
 */
export function extractText(raw) {
  let text = ''
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    let frame
    try {
      frame = JSON.parse(payload)
    } catch {
      // 半截帧，正文下一轮才到。
      continue
    }
    // OpenAI chat completions。
    const delta = frame?.choices?.[0]?.delta
    if (delta !== undefined && delta !== null) {
      if (typeof delta.content === 'string') text += delta.content
      if (typeof delta.reasoning_content === 'string') text += delta.reasoning_content
      if (typeof delta.reasoning === 'string') text += delta.reasoning
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (typeof call?.function?.arguments === 'string') text += call.function.arguments
        }
      }
      continue
    }
    // Anthropic messages / OpenAI responses。
    if (typeof frame?.delta?.text === 'string') text += frame.delta.text
    else if (typeof frame?.delta?.thinking === 'string') text += frame.delta.thinking
    else if (typeof frame?.delta?.reasoning_content === 'string') text += frame.delta.reasoning_content
    else if (typeof frame?.text === 'string') text += frame.text
    else if (typeof frame?.choices?.[0]?.text === 'string') text += frame.choices[0].text
    // 整段快照帧（非流式兜底或某些中转的实现）也在候选里。
    else if (Array.isArray(frame?.content)) {
      for (const block of frame.content) {
        if (block?.type === 'text' && typeof block.text === 'string') text += block.text
      }
    }
  }
  return text
}

/**
 * 从一份完整 JSON 响应里抽正文（非流式路径）。
 *
 * @param {unknown} body - 解析后的 JSON。
 * @returns {string} 正文。
 */
export function textOfJson(body) {
  if (body === null || typeof body !== 'object') return ''
  // Anthropic messages
  if (Array.isArray(body.content)) {
    return body.content
      .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('')
  }
  // OpenAI chat
  const choice = body?.choices?.[0]
  if (choice !== undefined) {
    if (typeof choice?.message?.content === 'string') return choice.message.content
    if (typeof choice?.text === 'string') return choice.text
  }
  // OpenAI responses
  if (typeof body.output_text === 'string') return body.output_text
  if (Array.isArray(body.output)) {
    return body.output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('')
  }
  return ''
}

/** 把一段字符串切成若干 SSE data 帧。 */
function frames(events) {
  let out = ''
  for (const [name, payload] of events) {
    if (name !== null) out += `event: ${name}\n`
    out += `data: ${JSON.stringify(payload)}\n\n`
  }
  return out
}

/**
 * 伪造一条完整的 Anthropic messages 流。
 *
 * 事件顺序是协议规定的，少一个 Claude Code 就报错：
 * message_start → content_block_start → content_block_delta → content_block_stop
 * → message_delta → message_stop。
 *
 * @param {string} text - 要发出的正文。可以是空串——但空串会让客户端拿到一条
 *   没有内容的消息，所以调用方应当给一段人话。
 * @param {string} model - 请求里写的模型名，原样回给客户端。
 * @returns {string} SSE 文本。
 */
export function synthAnthropicStream(text, model) {
  const body = String(text ?? '')
  return frames([
    ['message_start', {
      type: 'message_start',
      message: {
        id: `msg_feibi_${Date.now().toString(36)}`,
        type: 'message',
        role: 'assistant',
        model: typeof model === 'string' && model.length > 0 ? model : 'feibi-breaker-cc',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: body } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: Buffer.byteLength(body, 'utf8') },
    }],
    ['message_stop', { type: 'message_stop' }],
  ])
}

/**
 * 伪造一条 OpenAI chat completions 流。
 *
 * @param {string} text - 正文。
 * @param {string} model - 模型名。
 * @returns {string} SSE 文本。
 */
export function synthOpenAiStream(text, model) {
  const chunk = {
    id: `chatcmpl-feibi-${Date.now().toString(36)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: typeof model === 'string' && model.length > 0 ? model : 'feibi-breaker-cc',
    choices: [{ index: 0, delta: { content: String(text ?? '') }, finish_reason: 'stop' }],
  }
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
}

/**
 * 伪造一份非流式响应体。
 *
 * @param {string} text - 正文。
 * @param {string} model - 模型名。
 * @param {'anthropic'|'openai-chat'|'openai-responses'} protocol - 协议。
 * @returns {object} 响应 JSON。
 */
export function synthJsonBody(text, model, protocol) {
  const body = String(text ?? '')
  if (protocol === 'openai-chat') {
    return {
      id: `chatcmpl-feibi-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: typeof model === 'string' && model.length > 0 ? model : 'feibi-breaker-cc',
      choices: [{ index: 0, message: { role: 'assistant', content: body }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
  }
  if (protocol === 'openai-responses') {
    return {
      id: `resp_feibi_${Date.now().toString(36)}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: typeof model === 'string' && model.length > 0 ? model : 'feibi-breaker-cc',
      status: 'completed',
      output: [{
        type: 'message',
        id: `msg_feibi_${Date.now().toString(36)}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: body, annotations: [] }],
      }],
      output_text: body,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    }
  }
  return {
    id: `msg_feibi_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: typeof model === 'string' && model.length > 0 ? model : 'feibi-breaker-cc',
    content: [{ type: 'text', text: body }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}

/**
 * 按协议挑伪造器。
 *
 * @param {string} text - 正文。
 * @param {string} model - 模型名。
 * @param {string} protocol - 协议。
 * @returns {string} SSE 文本。
 */
export function synthStream(text, model, protocol) {
  if (protocol === 'anthropic') return synthAnthropicStream(text, model)
  return synthOpenAiStream(text, model)
}
