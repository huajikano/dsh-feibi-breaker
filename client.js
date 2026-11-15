window.__ModuleLoader__.load({
  id: 'feibi-breaker',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // A fixed overlay must leave the docked composer, so it portals when the
    // module table offers react-dom and renders inline when it does not.
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (reactDom !== null && typeof reactDom.createPortal === 'function') createPortal = reactDom.createPortal
    } catch {
      createPortal = null
    }

    const NS = 'feibi-breaker'
    const STATE_PATH = '/api/feibi-breaker/state'
    const DECIDE_PATH = '/api/feibi-breaker/decide'
    const CONFIG_PATH = '/api/feibi-breaker/config'
    const PREVIEW_PATH = '/api/feibi-breaker/preview'
    const PROMPT_PATH = '/api/feibi-breaker/prompt'
    const PROMPT_RESET_PATH = '/api/feibi-breaker/prompt/reset'
    const SELFTEST_PATH = '/api/feibi-breaker/selftest'

    /** Projection key the badge subscribes to. */
    const PROJECTION_KEY = 'feibi-breaker'

    // -----------------------------------------------------------------------
    // Copy
    // -----------------------------------------------------------------------

    const ZH = {
      title: '菲比破限',
      nav: '菲比破限',
      lead: '提示词塑形 + 提交前拦截：拒绝性回复既少产生，也不落进会话。',
      tabSettings: '设置',
      tabReview: '待审核',
      tabHistory: '最近记录',

      // armor half
      armorTitle: '破甲（提示词）',
      armorHint: '改写系统提示词，从源头减少拒绝的产生。',
      armorEnabled: '启用提示词注入',
      armorEnabledHint: '关闭后不再注入任何提示词段，只保留拦截。',
      dualLayer: '双段镜像注入',
      dualLayerHint: 'Order 100 与 Order 200 各注入一份同源载荷。关闭可省 token，行为等价。',

      // prompt transparency
      promptTitle: '提示词内容',
      promptHint: '提示词以文件为准，改完保存后下一轮对话立即生效，无需重启。',
      promptLoading: '正在读取提示词…',
      promptPath: '文件',
      promptSourceCustom: '自定义',
      promptSourceDefault: '内置默认',
      promptSourceEmpty: '空',
      promptChars: '字数',
      promptHash: '哈希',
      promptUpdated: '更新于',
      promptLoadFailed: '读取提示词失败',
      promptSave: '保存提示词',
      promptSaving: '保存中…',
      promptSaved: '已保存，下一轮生效',
      promptSaveFailed: '保存失败',
      promptReset: '恢复默认',
      promptResetting: '正在恢复…',
      promptResetConfirm: '恢复默认会删除你的自定义稿。继续？',
      promptResetDone: '已恢复内置默认',
      promptReload: '重新读取',
      promptDirty: '有未保存的修改',
      promptClean: '已同步',
      promptEmptyWarning: '提示词为空时不会注入任何内容，模型会回到宿主默认人格。',
      promptDefaultHint: '当前显示的就是内置默认全文，可以直接在此基础上修改。',
      promptCopyDefault: '载入默认全文',
      promptNoFile: '文件尚未创建，保存后生成。',

      // refusal retry
      retryTitle: '拒绝后自动重试',
      retryHint: '拦截命中后自动补一条纠正消息，让模型重答一次，而不是留一轮空回复。',
      retryEnabled: '命中后自动重试',
      retryEnabledHint: '每次重试都是一次额外的模型调用，会产生 token 消耗。',
      retryMax: '每条请求最多重试',
      retryMaxHint: '达到上限后放弃，那一轮仍按拦截处理。用户发新消息后计数重置。',

      // self-test
      selfTestTitle: '自测（真调模型）',
      selfTestHint: '用当前模型跑几条探测，看提示词在这个模型上到底有没有效。每条都是一次真实的模型调用。',
      selfTestRun: '开始自测',
      selfTestRunning: '正在跑…（会调用模型，请稍候）',
      selfTestCases: '探测条数',
      selfTestFailed: '自测没能跑起来',
      selfTestNoRoute: '还不知道当前模型：先在对话里发一条消息再回来跑。',
      selfTestOk: '通过',
      selfTestRefused: '拒绝',
      selfTestEmpty: '空回答',
      selfTestErrored: '未测到',
      selfTestPassRate: '整体通过率',
      selfTestMeasuredRate: '有效样本通过率',
      selfTestEmptyWarn: '空回答不是拒绝，也不算通过 —— 通常是被 maxTokens 截断或首轮去跑工具预检。',
      selfTestErroredWarn: '调用本身失败（鉴权/限流/网络），这些轮次什么都没测到。',
      selfTestCostWarn: '每条例一次真实模型调用，会产生 token 消耗。',

      // guard half
      basicTitle: '拦截（回复）',
      basicHint: '选择内容在何处检查，以及命中后的处理方式。',
      enabled: '启用拦截',
      enabledHint: '关闭后所有回复原样进入会话。',
      interceptAt: '拦截位置',
      modeStream: '结构化流',
      modeWire: '网络响应',
      modeBoth: '双层拦截',
      modePreview: '实时预览',
      modeStreamHint: '在内容进入 DSH 前检查开头，保留原有模式。',
      modeWireHint: '检查适配器之前的 HTTP 响应；协议兼容性与延迟需单独评估。',
      modeBothHint: '同时启用网络和结构化流拦截。',
      modePreviewHint: '即时显示临时预览；完整输出检查通过后正式提交。',
      onDetect: '命中后',
      onDetectAsk: '先问我（暂存回复，等我放行或丢弃）',
      onDetectBlock: '自动丢弃',
      onDetectHint: '选“先问我”时，回复会暂停在待审区，等你决定后原样放行或丢弃。',
      dryRun: '演练模式',
      dryRunHint: '只记录不拦截，用来先观察判定是否准确。',

      // scope
      scopeTitle: '检测范围',
      scopeHint: '扩大检测范围可能增加误拦。工具参数中也可能包含测试样本。',
      scanReasoning: '同时检查思考内容',
      scanReasoningHint: '思考里引用的拒绝句也算命中（含引号内的句子）。关掉就只看最终回复。',
      scanTools: '检查工具参数',
      scanToolsHint: '写文件、发送消息的参数也参与检查，可能命中引用样本。',

      // words
      wordsTitle: '自定义词库',
      wordsHint: '一行一条，按纯文本匹配。修改后点击保存。',
      blocklist: '自定义拦截词库',
      blocklistHint: '一行一个，纯文本匹配（不区分大小写），命中任一行就拦截。用来补内置规则抓不到的说法。',
      blocklistPlaceholder: '例如：\n帮不了\n无法配合\nnot able to help',
      blocklistCount: '当前 {count} 条',
      blocklistSeed: '填入推荐词库',
      blocklistClear: '清空',

      // advanced
      advancedTitle: '高级参数',
      advancedHint: '检测窗口、等待时间与网络选项',
      scanChars: '检测长度',
      scanCharsHint: '检查回复的前多少个字符。',
      minCharsLabel: '最短检测长度',
      askTimeoutMs: '等待超时（毫秒）',
      askTimeoutHint: '超时无人处理就按丢弃处理。',
      replacement: '替换文本',
      replacementHint: '留空时不写标记。网络模式空替换可能触发提供方的空响应检查。',
      blockToolCalls: '连带工具调用一起拦',
      blockToolCallsHint: '默认放行带工具调用的回复——它在干活，不是在拒绝。',
      fastLabel: '快速放行',
      fastHint: '无信号时提前放行；后文出现的拒绝可能漏掉。',
      fastProbe: '快速检查长度',
      disabledPreviewFields: '实时预览会检查完整输出，不使用开头窗口或快速放行。',

      // wire
      wireSection: 'TLS 层选项',
      wireSafeHint: '此模式是 HTTP/fetch 层处理，不是系统级 TLS 解密。',
      wireScanResponses: '检查响应流',
      wireScanResponsesHint: '边收边判，命中即中止上游连接。',
      wireScanRequests: '检查出站请求',
      wireScanRequestsHint: '在请求发出前扫描提示词内容。',
      wireBlockRequests: '命中就拒发（否则只记录）',
      wireAbortUpstream: '命中后断开上游',
      wireAbortUpstreamHint: '省掉剩余 token，但流会以终止帧收尾。',
      wireUrlPatterns: 'LLM 端点匹配',
      wireUrlPatternsHint: '每行一个片段，URL 含任一片段才处理。留空等于关闭 TLS 层。',
      wireTerminator: '终止帧',
      wireTerminatorHint: '自定义协议终止帧。留空使用内置收尾；仅 [DONE] 可能导致适配器报错。',
      wireReleaseLabel: '网络模式放行长度',

      // save
      dirty: '有未保存的修改',
      clean: '配置已同步',
      undo: '撤销修改',
      save: '保存',
      saving: '保存中…',
      saved: '已保存（插件会重启生效）',
      saveFailed: '保存失败',
      fieldInvalid: '请填写有效的整数，且不小于字段标注的最小值。',
      restartHint: '保存会重载插件。请先处理正在审核的回复。',

      // status
      statusEnabled: '已启用',
      statusDisabled: '已停用',
      statusDry: '演练中',
      checkedLabel: '已检查',
      pendingLabel: '当前待审',
      blockedLabel: '拦截记录',
      withheldLabel: '本次会话已拦',
      historyHint: '仅保留本次运行的最近记录；重新加载插件后会清空。',
      reviewEmptyHint: '选择“先问我”后，命中的回复会在这里等待处理。',
      historyEmptyHint: '命中事件出现后，可在这里查看处理结果。',
      callsSeen: '本插件已检查 {calls} 次模型调用',
      callsHint: '如果模型明明回了拒绝话术但这个数字没涨，说明插件当时没被加载。',
      counters: '累计：拦截 {blocked} · 放行 {released} · 待审 {asked}',
      loading: '正在读取配置…',
      loadingFailed: '读不到配置：插件路由没有响应。检查插件是否启用，或点上面的「重试」。',
      error: '读取状态失败',
      reload: '重试',

      // pending / review
      pending: '待审回复',
      pendingEmpty: '没有待审的回复。',
      recent: '最近记录',
      recentEmpty: '还没有拦截记录。',
      outcomeBlocked: '已拦截',
      outcomeReleased: '已放行',
      outcomeDry: '演练命中',
      release: '放行',
      block: '丢弃',
      chars: '字符',
      bannerLead: '有 {count} 条回复被拦下，等待你决定',
      bannerOpen: '去处理',
      bannerHint: '点这里查看具体内容',
      reviewTitle: '审核被拦截的回复',
      reviewHint: '放行后原文会进入会话，这一轮继续；丢弃则什么都不写。',
      reviewReason: '命中原因',
      reviewContent: '待审核原文',
      historyContent: '查看记录摘要',
      noContent: '此记录未保留原文。',
      releaseHint: '允许原始内容进入会话',
      discardHint: '丢弃本次回复',
      close: '关闭',

      // preview
      previewHint: '预览是临时界面，不是持久聊天，可能短暂显示拒绝内容。插件不额外请求模型；完整检查通过或你放行后才提交，工具执行仍等待提交。',
      previewBlocked: '已丢弃 · 原文未提交',
      previewFailed: '生成失败 · 原文未提交',
      previewReceiving: '临时预览 · 尚未提交',
      previewReview: '等待你审核 · 尚未提交',
      previewChecking: '检查中 · 尚未提交',
      previewCommitting: '正在提交',
      previewTruncated: '预览仅显示末尾内容；检查与回放仍保留完整内容。',
      previewThinking: '思考预览（临时）',
      previewTools: '待提交工具：',
      previewDisconnected: '预览连接中断，正在重连；不会自动放行。',

      // badge
      badgeActive: '菲比破限已激活',
      badgeArmorOnly: '破甲已激活',
      badgeGuardOff: '拦截已关闭',
      badgeRunning: '执行中…',
      badgePass: '✓ 通过',
      badgeRefusal: '✗ 拒绝',
      badgeFallback: '△ 改口',
      badgeBlocked: '⛔ 已拦截',
      badgeDomain: '域',
      badgeRisk: '载荷',
    }

    const EN = {
      title: 'Feibi Breaker',
      nav: 'Feibi Breaker',
      lead: 'Prompt shaping plus pre-commit interception: refusals are produced less often and never land in the session.',
      tabSettings: 'Settings',
      tabReview: 'Review',
      tabHistory: 'Recent records',

      armorTitle: 'Armor (prompt)',
      armorHint: 'Rewrites the system prompt so a refusal is less likely to be produced at all.',
      armorEnabled: 'Inject the prompt sections',
      armorEnabledHint: 'Off leaves interception alone, with no prompt injection.',
      dualLayer: 'Dual-layer mirror injection',
      dualLayerHint: 'One payload at order 100 and a second at order 200. Off saves tokens with equivalent behavior.',

      promptTitle: 'Prompt content',
      promptHint: 'The prompt lives in a file. Saving applies it on the next turn, with no restart.',
      promptLoading: 'Loading prompt…',
      promptPath: 'File',
      promptSourceCustom: 'Custom',
      promptSourceDefault: 'Bundled default',
      promptSourceEmpty: 'Empty',
      promptChars: 'chars',
      promptHash: 'hash',
      promptUpdated: 'updated',
      promptLoadFailed: 'Could not read the prompt',
      promptSave: 'Save prompt',
      promptSaving: 'Saving…',
      promptSaved: 'Saved — applies next turn',
      promptSaveFailed: 'Save failed',
      promptReset: 'Restore default',
      promptResetting: 'Restoring…',
      promptResetConfirm: 'Restoring deletes your custom copy. Continue?',
      promptResetDone: 'Bundled default restored',
      promptReload: 'Reload',
      promptDirty: 'Unsaved changes',
      promptClean: 'Synced',
      promptEmptyWarning: 'An empty prompt injects nothing, and the model falls back to the host persona.',
      promptDefaultHint: 'This is the bundled default in full; edit it in place if you want to.',
      promptCopyDefault: 'Load the default text',
      promptNoFile: 'The file does not exist yet; saving creates it.',

      retryTitle: 'Retry after a refusal',
      retryHint: 'When a reply is withheld, send one corrective message so the model answers instead of leaving the turn empty.',
      retryEnabled: 'Retry on a block',
      retryEnabledHint: 'Each retry is another model call and costs tokens.',
      retryMax: 'Attempts per request',
      retryMaxHint: 'After this many, the turn stays blocked. A new user message resets the count.',

      selfTestTitle: 'Self-test (live model)',
      selfTestHint: 'Run a few probes against the current model to see whether the prompt actually works on it. Every probe is a real model call.',
      selfTestRun: 'Run self-test',
      selfTestRunning: 'Running… (calling the model, this takes a moment)',
      selfTestCases: 'Probes',
      selfTestFailed: 'The self-test could not run',
      selfTestNoRoute: 'The current model is unknown: send one message in a conversation, then come back.',
      selfTestOk: 'pass',
      selfTestRefused: 'refused',
      selfTestEmpty: 'empty',
      selfTestErrored: 'not measured',
      selfTestPassRate: 'Overall pass rate',
      selfTestMeasuredRate: 'Rate over measured probes',
      selfTestEmptyWarn: 'An empty reply is not a refusal and not a pass — usually a maxTokens cut or a tool pre-flight on the first turn.',
      selfTestErroredWarn: 'The call itself failed (auth, rate limit, network); those probes measured nothing.',
      selfTestCostWarn: 'Each probe is one real model call and costs tokens.',

      basicTitle: 'Interception',
      basicHint: 'Choose where to inspect content and what happens on a match.',
      enabled: 'Guard replies',
      enabledHint: 'When off, every reply enters the session unchanged.',
      interceptAt: 'Intercept at',
      modeStream: 'Structured stream',
      modeWire: 'Network response',
      modeBoth: 'Both layers',
      modePreview: 'Live preview',
      modeStreamHint: 'Inspect the opening before it reaches DSH. Keeps the existing behavior.',
      modeWireHint: 'Inspect HTTP before the adapter; protocol support and latency vary.',
      modeBothHint: 'Enable both network and structured stream interception.',
      modePreviewHint: 'Show a transient preview immediately, then submit after the full check.',
      onDetect: 'On a match',
      onDetectAsk: 'Ask me first (hold the reply until I release or discard it)',
      onDetectBlock: 'Discard automatically',
      onDetectHint: 'With "ask me first", the reply pauses in the pending list until you decide.',
      dryRun: 'Dry run',
      dryRunHint: 'Record detections without blocking, to check the rule first.',

      scopeTitle: 'Detection scope',
      scopeHint: 'Wider inspection may match quoted examples in reasoning or tool arguments.',
      scanReasoning: 'Also inspect reasoning',
      scanReasoningHint: 'A refusal quoted inside the thinking counts too. Off means only the final reply is checked.',
      scanTools: 'Inspect tool arguments',
      scanToolsHint: 'File writes and messages may contain quoted test examples.',

      wordsTitle: 'Custom blocklist',
      wordsHint: 'One plain-text phrase per line. Save to apply your changes.',
      blocklist: 'Custom blocklist',
      blocklistHint: 'One entry per line, plain case-insensitive text. Any hit blocks. Use it for phrasings the built-in rules miss.',
      blocklistPlaceholder: 'for example:\nnot able to help\ncannot assist with',
      blocklistCount: '{count} entries',
      blocklistSeed: 'Fill in a starter list',
      blocklistClear: 'Clear',

      advancedTitle: 'Advanced settings',
      advancedHint: 'Scan windows, decision timeout and network options',
      scanChars: 'Scan length',
      scanCharsHint: 'How many leading characters of a reply to inspect.',
      minCharsLabel: 'Minimum scan length',
      askTimeoutMs: 'Decision timeout (ms)',
      askTimeoutHint: 'Unattended replies are discarded after this.',
      replacement: 'Replacement text',
      replacementHint: 'Empty writes no marker. Network mode may reject an empty replacement as an empty response.',
      blockToolCalls: 'Also block replies that call tools',
      blockToolCallsHint: 'By default a tool-calling reply is doing work, not refusing.',
      fastLabel: 'Early release',
      fastHint: 'Release early when no signal is seen; a later refusal can be missed.',
      fastProbe: 'Early scan length',
      disabledPreviewFields: 'Live preview checks the complete output; opening windows and early release do not apply.',

      wireSection: 'TLS-layer options',
      wireSafeHint: 'This is HTTP/fetch processing, not system-wide TLS decryption.',
      wireScanResponses: 'Inspect the response stream',
      wireScanResponsesHint: 'Decide while streaming; a match cancels the upstream connection.',
      wireScanRequests: 'Inspect the outgoing request',
      wireScanRequestsHint: 'Scan the prompt before it is sent.',
      wireBlockRequests: 'Refuse to send on a match (otherwise record only)',
      wireAbortUpstream: 'Cancel the upstream connection on a match',
      wireAbortUpstreamHint: 'Saves the remaining tokens; the stream closes with the terminator frame.',
      wireUrlPatterns: 'LLM endpoint matching',
      wireUrlPatternsHint: 'One fragment per line; a URL is inspected only when it contains one. Empty disables the TLS layer.',
      wireTerminator: 'Terminator frame',
      wireTerminatorHint: 'Custom protocol terminator. Empty uses built-in finalization; [DONE] alone may cause adapter errors.',
      wireReleaseLabel: 'Network release length',

      dirty: 'Unsaved changes',
      clean: 'Configuration synced',
      undo: 'Revert changes',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved — the plugin restarts to apply it',
      saveFailed: 'Save failed',
      fieldInvalid: 'Enter a whole number at or above the stated minimum.',
      restartHint: 'Saving reloads the plugin. Settle pending reviews first.',

      statusEnabled: 'Enabled',
      statusDisabled: 'Disabled',
      statusDry: 'Dry run',
      checkedLabel: 'Inspected',
      pendingLabel: 'Awaiting review',
      blockedLabel: 'Match records',
      withheldLabel: 'Withheld this session',
      historyHint: 'Recent records are kept for this activation and reset when the plugin reloads.',
      reviewEmptyHint: 'Select "Ask me first" to hold matching replies here for review.',
      historyEmptyHint: 'When a match occurs, its outcome appears here.',
      callsSeen: 'This plugin has inspected {calls} model calls',
      callsHint: 'If a refusal went through while this number did not move, the plugin was not loaded at that moment.',
      counters: 'Total: {blocked} blocked · {released} released · {asked} asked',
      loading: 'Loading configuration…',
      loadingFailed: 'Cannot read the configuration: the plugin routes did not answer. Check that the plugin is enabled, or press Retry above.',
      error: 'Could not read the guard state',
      reload: 'Retry',

      pending: 'Pending replies',
      pendingEmpty: 'Nothing is waiting.',
      recent: 'Recent records',
      recentEmpty: 'No detections yet.',
      outcomeBlocked: 'blocked',
      outcomeReleased: 'released',
      outcomeDry: 'dry-run hit',
      release: 'Release',
      block: 'Discard',
      chars: 'chars',
      bannerLead: '{count} reply held for your decision',
      bannerOpen: 'Review',
      bannerHint: 'Click to see the content',
      reviewTitle: 'Review the held reply',
      reviewHint: 'Releasing puts the original text into the session and the turn continues; discarding writes nothing.',
      reviewReason: 'Match reason',
      reviewContent: 'Original content for review',
      historyContent: 'View record summary',
      noContent: 'Original content was not retained for this record.',
      releaseHint: 'Admit the original content to the conversation',
      discardHint: 'Discard this reply',
      close: 'Close',

      previewHint: 'Preview is transient UI, not durable chat, and can briefly show refusal content. No extra model request is made. Content is submitted only after the full check or your release; tools still wait for submission.',
      previewBlocked: 'Discarded · original not submitted',
      previewFailed: 'Generation failed · original not submitted',
      previewReceiving: 'Live preview · not submitted',
      previewReview: 'Awaiting review · not submitted',
      previewChecking: 'Checking · not submitted',
      previewCommitting: 'Submitting',
      previewTruncated: 'Only the preview tail is shown; full content is retained for checking and replay.',
      previewThinking: 'Transient reasoning preview',
      previewTools: 'Pending tools: ',
      previewDisconnected: 'Preview disconnected; reconnecting without approving anything.',

      badgeActive: 'Feibi Breaker active',
      badgeArmorOnly: 'Armor active',
      badgeGuardOff: 'Guard off',
      badgeRunning: 'Running…',
      badgePass: '✓ pass',
      badgeRefusal: '✗ refusal',
      badgeFallback: '△ pivot',
      badgeBlocked: '⛔ withheld',
      badgeDomain: 'domain',
      badgeRisk: 'payload',
    }

    /** Fill `{name}` placeholders. */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole))
    }

    // -----------------------------------------------------------------------
    // Transport
    // -----------------------------------------------------------------------

    async function readState() {
      const response = await fetch(new URL(STATE_PATH, window.location.origin), { credentials: 'include' })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      return await response.json()
    }

    async function postJson(path, body) {
      const response = await fetch(new URL(path, window.location.origin), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(value && value.error ? value.error : 'HTTP ' + String(response.status))
      return value
    }

    /**
     * Poll the guard state while a component is mounted.
     *
     * @param intervalMs - poll period.
     * @returns the latest state, the last error, and a manual refresh.
     */
    function useGuardState(intervalMs) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [nonce, setNonce] = React.useState(0)

      React.useEffect(() => {
        let live = true
        const ask = async () => {
          try {
            const next = await readState()
            if (!live) return
            setState(next)
            setError(null)
          } catch (failure) {
            if (live) setError(failure instanceof Error ? failure.message : String(failure))
          }
        }
        ask()
        const timer = window.setInterval(ask, intervalMs)
        return () => {
          live = false
          window.clearInterval(timer)
        }
      }, [intervalMs, nonce])

      return { state, error, refresh: () => setNonce((value) => value + 1) }
    }

    // -----------------------------------------------------------------------
    // Shared UI atoms
    // -----------------------------------------------------------------------

    /**
     * One button that keeps the host look while staying self-contained.
     *
     * Every color carries a literal fallback: a theme variable that resolves to
     * nothing in this slot context used to make the primary button transparent
     * on transparent — present in the DOM, invisible on screen.
     */
    function Button(props) {
      const base = {
        font: 'inherit',
        fontSize: 12,
        lineHeight: '20px',
        padding: '0 10px',
        height: 28,
        borderRadius: 6,
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: props.primary ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
        color: props.primary ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
        whiteSpace: 'nowrap',
      }
      return h('button', {
        type: 'button',
        disabled: props.disabled,
        onClick: props.onClick,
        style: { ...base, ...(props.style || {}) },
        title: props.title,
        className: 'fgk-button',
      }, props.children)
    }

    function Row(props) {
      return h('label', { className: 'fgk-field' },
        h('span', { className: 'fgk-field-title' }, props.label),
        props.hint ? h('span', { className: 'fgk-muted fgk-hint' }, props.hint) : null,
        h('span', { className: 'fgk-control' }, props.children),
      )
    }

    function Toggle(props) {
      return h('span', { className: 'fgk-toggle' },
        h('input', { type: 'checkbox', role: 'switch', checked: props.checked,
          'aria-checked': props.checked, 'aria-label': props.label,
          onChange: event => props.onChange(event.target.checked),
          style: { accentColor: 'var(--dsw-alias-brand-primary)' } }),
        h('span', { 'aria-hidden': true }, props.children),
      )
    }

    function textStyle() {
      return { font: 'inherit', fontSize: 13, padding: '7px 10px', width: '100%', minWidth: 0,
        boxSizing: 'border-box', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' }
    }

    /** Fields edited as text and parsed once, on save, with their minimum. */
    const NUMERIC_FIELDS = { scanChars: 1, minChars: 0, askTimeoutMs: 1 }

    const UI_CSS = `
.fgk-page{width:100%;max-width:800px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-sizing:border-box}
.fgk-page *{box-sizing:border-box}.fgk-page [hidden]{display:none!important}
.fgk-page h2{margin:0;font-size:22px;font-weight:650;letter-spacing:-.4px}
.fgk-page h3{margin:0;font-size:14px}.fgk-page h4{font-size:13px}
.fgk-page p{margin:5px 0}
.fgk-page-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:4px 0 16px}
.fgk-muted{color:var(--dsw-alias-label-secondary)}.fgk-hint{font-size:12px;line-height:1.6}
.fgk-badge{display:inline-flex;align-items:center;padding:3px 9px;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;white-space:nowrap;background:var(--dsw-alias-bg-layer-2)}
.fgk-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:12px}
.fgk-metrics>div{display:grid;gap:3px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.fgk-metrics strong{font-size:21px;font-weight:600}.fgk-metrics span{font-size:11px}
.fgk-savebar{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;margin-bottom:14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
.fgk-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fgk-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:16px}
.fgk-tabs button{appearance:none;font:inherit;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary);padding:10px 12px;border:0;border-bottom:2px solid transparent}
.fgk-tabs button[aria-selected=true]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.fgk-stack{display:grid;gap:12px}
.fgk-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px;display:grid;gap:10px;background:var(--dsw-alias-bg-layer-1)}
.fgk-section-heading{display:grid;gap:2px}
.fgk-field{display:grid;gap:4px;grid-template-columns:1fr;padding:4px 0}
.fgk-field-title{font-weight:550}
.fgk-control{display:block;width:100%}
.fgk-toggle{display:inline-flex;align-items:center;gap:8px}
.fgk-note{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.fgk-error{display:flex;align-items:center;gap:10px;font-size:12px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.fgk-empty{display:grid;gap:4px;padding:20px 4px;color:var(--dsw-alias-label-secondary);font-size:13px}
.fgk-original{margin:0;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-base)}
.fgk-footer{padding:18px 0 4px;font-size:11px}
@keyframes fgkPulse{0%,100%{box-shadow:0 0 2px rgba(16,185,129,.5);opacity:1}50%{box-shadow:0 0 14px rgba(16,185,129,1);opacity:.6}}
@keyframes fgkFlash{0%{transform:scale(1)}30%{transform:scale(1.1)}100%{transform:scale(1)}}
`

    const BUILD = 'v1.0.0'

    /** A starter word list for the phrasings the built-in rules do not cover. */
    const SEED_BLOCKLIST = [
      '帮不了',
      '帮不上',
      '无法配合',
      '不能配合',
      '恕难从命',
      'not able to help',
      'unable to comply',
      'cannot assist with',
      'not something i can help',
    ]

    // -----------------------------------------------------------------------
    // Badge — the merged status indicator
    // -----------------------------------------------------------------------

    const BADGE_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      width: 'fit-content',
      padding: '3px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(16, 185, 129, 0.45)',
      background: 'rgba(16, 185, 129, 0.12)',
      color: 'inherit',
      fontSize: '11px',
      lineHeight: '16px',
      fontFamily: 'inherit',
      userSelect: 'none',
      whiteSpace: 'nowrap',
    }
    const DOT_STYLE = {
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: '#10b981',
      flex: 'none',
    }
    const FLASH_MS = 2500

    /**
     * The status badge above the composer.
     *
     * It reads the projection, which is fed by both the transcript and the
     * verdict bus. That is what lets it say "已拦截" for a reply that never
     * reached the transcript at all — the single thing neither original plugin
     * could report on its own.
     */
    function StatusBadge(props) {
      const useProjection = props.useProjection
      const t = props.t || ((key) => ZH[key] || EN[key] || key)
      const state = typeof useProjection === 'function' ? useProjection(PROJECTION_KEY) : undefined

      const lastVerdictRef = React.useRef(null)
      const flashUntilRef = React.useRef(0)
      const setTick = React.useState(0)[1]

      React.useEffect(() => {
        const v = state && state.verdict ? state.verdict : null
        if (v !== lastVerdictRef.current) {
          lastVerdictRef.current = v
          if (v) flashUntilRef.current = Date.now() + FLASH_MS
          setTick(Date.now())
        }
      }, [state])

      const running = !!(state && state.running)
      const words = state && Array.isArray(state.words) ? state.words : []
      const risk = state && Array.isArray(state.risk) ? state.risk : []
      const domain = state && state.domain ? state.domain : null
      const blocked = !!(state && state.blocked)
      const showVerdict = !running && lastVerdictRef.current !== null && Date.now() < flashUntilRef.current

      let text = t('badgeActive')
      const dotStyle = { ...DOT_STYLE }
      const badgeStyle = { ...BADGE_STYLE }

      if (running) {
        dotStyle.animation = 'fgkPulse 1.2s ease-in-out infinite'
        text = t('badgeRunning')
      } else if (showVerdict) {
        const verdict = lastVerdictRef.current
        if (blocked) {
          // The guard ate this reply. The transcript is empty, so this line is
          // the only evidence the user gets that anything happened.
          text = t('badgeBlocked') + (domain ? ' · ' + domain : '')
          badgeStyle.animation = 'fgkFlash 1.6s ease'
          badgeStyle.borderColor = 'rgba(239, 68, 68, 0.5)'
          badgeStyle.background = 'rgba(239, 68, 68, 0.12)'
          dotStyle.background = '#ef4444'
        } else if (verdict === 'pass') {
          text = t('badgePass')
            + (domain ? ' · ' + domain : '')
            + (risk.length ? ' · ' + t('badgeRisk') + 'x' + risk.length : '')
          badgeStyle.animation = 'fgkFlash 1.2s ease'
        } else if (verdict === 'fallback') {
          text = t('badgeFallback') + (words[0] ? ' · ' + words[0] : '')
          badgeStyle.animation = 'fgkFlash 1.4s ease'
          badgeStyle.borderColor = 'rgba(245, 158, 11, 0.5)'
          badgeStyle.background = 'rgba(245, 158, 11, 0.12)'
          dotStyle.background = '#f59e0b'
        } else {
          text = t('badgeRefusal') + (words[0] ? ' · ' + words[0] : '')
          badgeStyle.animation = 'fgkFlash 1.6s ease'
          badgeStyle.borderColor = 'rgba(239, 68, 68, 0.5)'
          badgeStyle.background = 'rgba(239, 68, 68, 0.12)'
          dotStyle.background = '#ef4444'
        }
      }

      const withheld = state && typeof state.withheld === 'number' ? state.withheld : 0
      const title = t('badgeActive') + (withheld > 0 ? ' · ' + fill(t('withheldLabel'), {}) + ' ' + withheld : '')

      return h('div', { style: { display: 'flex', justifyContent: 'center', width: '100%' } },
        h('div', {
          style: badgeStyle,
          'data-armor': 'on',
          'data-plugin': PROJECTION_KEY,
          'data-blocked': blocked ? 'true' : 'false',
          title,
        },
          h('span', { style: dotStyle }),
          h('span', null, text),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Preview dock
    // -----------------------------------------------------------------------

    /** Session-private ephemeral SSE; disconnect never grants admission. */
    function PreviewDock(props) {
      const [items, setItems] = React.useState([])
      const [disconnected, setDisconnected] = React.useState(false)
      const sessionId = props.sessionId
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || !sessionId) return
        let live = true
        let source = null
        const disconnect = () => {
          if (source) {
            source.onmessage = null
            source.onerror = null
            source.close()
            source = null
          }
        }
        const connect = () => {
          if (!live || source || document.visibilityState === 'hidden') return
          const url = new URL(PREVIEW_PATH, window.location.origin)
          url.searchParams.set('sessionId', sessionId)
          try {
            const active = new EventSource(url.toString(), { withCredentials: true })
            source = active
            active.onmessage = event => {
              if (!live || source !== active) return
              try {
                const snapshot = JSON.parse(event.data)
                if (!Array.isArray(snapshot.items)) throw new Error('invalid preview snapshot')
                // Protect both session isolation and blocked/failed redaction at
                // the view boundary, even if a stale server sends raw fields.
                const statuses = ['receiving', 'checking', 'review', 'committing', 'blocked', 'failed']
                setItems(snapshot.items.filter(item => item && item.sessionId === sessionId && typeof item.id === 'string' && statuses.includes(item.status)).map(item => {
                  const hidden = item.status === 'blocked' || item.status === 'failed'
                  return {
                    id: item.id, status: item.status,
                    text: !hidden && typeof item.text === 'string' ? item.text : '',
                    reasoning: !hidden && typeof item.reasoning === 'string' ? item.reasoning : '',
                    toolNames: !hidden && Array.isArray(item.toolNames) ? item.toolNames.filter(name => typeof name === 'string') : [],
                    truncated: !hidden && item.truncated === true,
                  }
                }))
                setDisconnected(false)
              } catch {
                setItems([])
                setDisconnected(true)
              }
            }
            active.onerror = () => {
              if (!live || source !== active) return
              setItems([])
              setDisconnected(true)
              // EventSource reconnects itself and receives a fresh snapshot.
              // A disconnect never sends a decision or changes admission.
            }
          } catch {
            setItems([])
            setDisconnected(true)
          }
        }
        const visibility = () => {
          setItems([])
          if (document.visibilityState === 'hidden') {
            disconnect()
            setDisconnected(false)
          } else connect()
        }
        setItems([])
        setDisconnected(false)
        document.addEventListener('visibilitychange', visibility)
        connect()
        return () => {
          live = false
          disconnect()
          document.removeEventListener('visibilitychange', visibility)
        }
      }, [sessionId])
      const t = props.t
      if (items.length === 0 && !disconnected) return null
      return h('div', { style: { display: 'grid', gap: 8 } },
        disconnected ? h('span', { role: 'status', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('previewDisconnected')) : null,
        ...items.map(item => h('section', {
          key: item.id,
          'aria-label': t('previewReceiving'),
          style: { padding: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
        },
          h('div', { style: { fontSize: 12, marginBottom: 6, color: 'var(--dsw-alias-label-secondary)' } },
            t(item.status === 'blocked' ? 'previewBlocked' : item.status === 'failed' ? 'previewFailed' : item.status === 'review' ? 'previewReview' : item.status === 'checking' ? 'previewChecking' : item.status === 'committing' ? 'previewCommitting' : 'previewReceiving')),
          h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '40vh', overflow: 'auto', fontSize: 13 } }, item.text || ''),
          item.reasoning ? h('details', {}, h('summary', {}, t('previewThinking')),
            h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' } }, item.reasoning)) : null,
          item.toolNames?.length ? h('div', { style: { fontSize: 12 } }, t('previewTools') + item.toolNames.join(', ')) : null,
          item.truncated ? h('small', {}, t('previewTruncated')) : null,
        )),
      )
    }

    // -----------------------------------------------------------------------
    // Pending item + review panel
    // -----------------------------------------------------------------------

    function clockOf(createdAt) {
      try {
        return new Date(createdAt).toLocaleTimeString()
      } catch {
        return ''
      }
    }

    /** One held reply with the two decisions that settle it. */
    function PendingItem(props) {
      const [localBusy, setLocalBusy] = React.useState(false)
      const t = props.t
      const item = props.item
      const busy = props.busy === true || localBusy
      // The review panel drives the decision; the settings page lets the item
      // decide for itself. One component serves both.
      const decide = async (action) => {
        if (typeof props.onDecide === 'function') {
          await props.onDecide(action)
          return
        }
        setLocalBusy(true)
        try {
          await postJson(DECIDE_PATH, { id: item.id, action })
          props.onSettled()
        } catch (failure) {
          props.onError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLocalBusy(false)
        }
      }
      return h('div', {
        style: {
          display: 'grid', gap: 6, padding: 10, borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
        },
      },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
          h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, item.reason || 'refusal'),
          h('span', {}, String(item.chars) + ' ' + t('chars')),
          h('span', {}, clockOf(item.createdAt)),
          item.sessionId ? h('span', { style: { opacity: 0.7 } }, String(item.sessionId).slice(0, 8)) : null,
        ),
        h('div', {
          style: {
            fontSize: 13, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap',
            wordBreak: 'break-word', maxHeight: '42vh', overflow: 'auto', lineHeight: 1.75,
            padding: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-base)',
          },
        }, item.body || item.head || ''),
        h('div', { style: { display: 'flex', gap: 8 } },
          h(Button, { onClick: () => decide('release'), disabled: busy, primary: true, title: t('releaseHint'), style: { height: 34, padding: '0 16px' } }, t('release')),
          h(Button, { onClick: () => decide('block'), disabled: busy, title: t('discardHint'), style: { height: 34, padding: '0 16px' } }, t('block')),
        ),
      )
    }

    /**
     * A fixed overlay that leaves the docked composer.
     *
     * The dock slot warns that the composer contains fixed children, so the card
     * portals to the document body whenever the module table offers react-dom.
     * Without it the card still renders, inline, rather than failing.
     */
    function Overlay(props) {
      const [mounted, setMounted] = React.useState(false)
      const cardRef = React.useRef(null)
      React.useEffect(() => { setMounted(true) }, [])
      React.useEffect(() => {
        const previous = document.activeElement
        const card = cardRef.current
        card?.focus()
        const onKey = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); return }
          if (event.key !== 'Tab' || !card) return
          const controls = [...card.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')]
          if (!controls.length) { event.preventDefault(); card.focus(); return }
          const first = controls[0], last = controls[controls.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === card)) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === card)) { event.preventDefault(); first.focus() }
        }
        card?.addEventListener('keydown', onKey)
        return () => {
          card?.removeEventListener('keydown', onKey)
          if (previous?.isConnected && typeof previous.focus === 'function') previous.focus()
        }
      }, [mounted, props.onClose])

      const backdrop = {
        position: 'fixed', inset: 0, zIndex: 60, display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 12,
        background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent)',
      }
      const card = {
        display: 'grid', gap: 10, width: 'min(720px, 100%)', maxHeight: '80vh',
        overflow: 'auto', padding: 16, borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: '0 12px 40px var(--dsw-alias-border-l2)',
      }
      const node = h('div', {
        style: backdrop,
        onClick: (event) => { if (event.target === event.currentTarget) props.onClose() },
      }, h('div', { style: card, className: 'fgk-page', ref: cardRef, tabIndex: -1, role: 'dialog', 'aria-modal': true, 'aria-label': props.label },
        h('style', {}, UI_CSS), props.children))

      if (createPortal !== null && mounted) return createPortal(node, document.body)
      return node
    }

    /** The review panel: full content of every reply this session is waiting on. */
    function ReviewPanel(props) {
      const t = props.t
      const { state, refresh } = useGuardState(1500)
      const [busyId, setBusyId] = React.useState(null)
      const [failureMessage, setFailureMessage] = React.useState('')
      const all = state && Array.isArray(state.pending) ? state.pending : []
      const pending = typeof props.sessionId === 'string'
        ? all.filter((item) => item.sessionId === props.sessionId)
        : all

      // Nothing left to decide: leave the way the user asked for.
      React.useEffect(() => {
        if (state !== null && pending.length === 0) props.onClose()
      }, [state, pending.length, props.onClose])

      const decide = async (id, action) => {
        setBusyId(id)
        setFailureMessage('')
        try {
          await postJson(DECIDE_PATH, { id, action })
          refresh()
          props.onClose()
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure)
          setFailureMessage(message)
          props.onError(message)
        } finally {
          setBusyId(null)
        }
      }

      return h(Overlay, { onClose: props.onClose, label: t('reviewTitle') },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('h2', { style: { margin: 0, fontSize: 16, color: 'var(--dsw-alias-label-primary)' } }, t('reviewTitle')),
          h(Button, { onClick: props.onClose, style: { marginLeft: 'auto' } }, t('close')),
        ),
        h('div', { className: 'fgk-note' }, t('reviewHint')),
        failureMessage && h('div', { className: 'fgk-error', role: 'alert' }, failureMessage),
        pending.length === 0
          ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '12px 0' } }, t('pendingEmpty'))
          : pending.map((item) => h(PendingItem, {
            key: item.id, item, t, busy: busyId === item.id,
            onDecide: (action) => decide(item.id, action),
            onError: props.onError,
          })),
      )
    }

    // -----------------------------------------------------------------------
    // Dock: badge + preview + pending banner
    // -----------------------------------------------------------------------

    /**
     * The composer dock.
     *
     * All three things that belong under the input box live here, in one
     * component, because they are one story: the badge says whether the armor
     * is live, the banner says a reply is waiting, the preview says what is
     * being generated right now. Splitting them across three slot
     * registrations is what made the originals feel like two products.
     */
    function ComposerDock(props) {
      const t = props.t
      const { state } = useGuardState(2000)
      const [open, setOpen] = React.useState(false)
      const [error, setError] = React.useState(null)
      const all = state && Array.isArray(state.pending) ? state.pending : []
      const sessionId = props.sessionId
      const pending = typeof sessionId === 'string' ? all.filter((item) => item.sessionId === sessionId) : all
      const close = React.useCallback(() => setOpen(false), [])
      const inPreview = state?.config?.interceptAt === 'preview'

      return h('div', { style: { display: 'grid', gap: 8, width: '100%' } },
        h(StatusBadge, props),
        inPreview ? h(PreviewDock, { ...props, t }) : null,
        pending.length === 0 ? null : h('div', {
          role: 'button',
          tabIndex: 0,
          onClick: () => setOpen(true),
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') setOpen(true) },
          style: {
            display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
            margin: '4px 0', padding: '8px 12px', borderRadius: 8,
            border: '1px solid var(--dsw-alias-state-warn-primary)',
            background: 'var(--dsw-alias-bg-layer-2)', fontSize: 12,
            color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
          },
        },
          h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } },
            fill(t('bannerLead'), { count: pending.length })),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('bannerHint')),
          h('span', { style: { marginLeft: 'auto', color: 'var(--dsw-alias-brand-primary)' } }, t('bannerOpen') + ' →'),
        ),
        open ? h(ReviewPanel, { t, sessionId, onClose: close, onError: (message) => setError(message) }) : null,
        error !== null ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
      )
    }

    // -----------------------------------------------------------------------
    // Prompt panel
    // -----------------------------------------------------------------------

    /**
     * Read the prompt from this package's Host half.
     *
     * @returns {Promise<object>} the prompt payload.
     */
    async function readPrompt() {
      const response = await fetch(new URL(PROMPT_PATH, window.location.origin), { credentials: 'include' })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      return await response.json()
    }

    /**
     * The editable prompt.
     *
     * Three things make this "transparent" rather than just a text box:
     *
     *   - the **path** is shown, so the file is a real thing the user can open
     *     in an editor;
     *   - the **source badge** distinguishes "this is the shipped default" from
     *     "this is your edit", which the text alone cannot say;
     *   - **restore default** is one button away, and the bundled text is always
     *     available to load back into the box.
     *
     * Saving applies on the next turn because the Host evaluates the section
     * text per assemble; nothing restarts.
     */
    function PromptPanel(props) {
      const t = props.t
      const [prompt, setPrompt] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [status, setStatus] = React.useState('')
      const [failure, setFailure] = React.useState('')

      const load = React.useCallback(async () => {
        setFailure('')
        try {
          const next = await readPrompt()
          setPrompt(next)
          setDraft(null)
          setStatus('')
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      const content = draft !== null ? draft : (prompt?.content ?? '')
      const dirty = draft !== null && draft !== (prompt?.content ?? '')

      const save = async () => {
        if (status === 'saving' || !dirty) return
        setStatus('saving')
        setFailure('')
        try {
          const response = await fetch(new URL(PROMPT_PATH, window.location.origin), {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content }),
          })
          const value = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(value?.error || 'HTTP ' + String(response.status))
          setPrompt(value)
          setDraft(null)
          setStatus('saved')
        } catch (error) {
          setStatus('')
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }

      const reset = async () => {
        if (status === 'resetting') return
        if (typeof window.confirm === 'function' && !window.confirm(t('promptResetConfirm'))) return
        setStatus('resetting')
        setFailure('')
        try {
          const response = await fetch(new URL(PROMPT_RESET_PATH, window.location.origin), {
            method: 'POST',
            credentials: 'include',
          })
          const value = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(value?.error || 'HTTP ' + String(response.status))
          setPrompt(value)
          setDraft(null)
          setStatus('resetDone')
        } catch (error) {
          setStatus('')
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }

      const source = prompt?.source ?? null
      const sourceLabel = source === 'custom'
        ? t('promptSourceCustom')
        : source === 'default'
          ? t('promptSourceDefault')
          : t('promptSourceEmpty')
      const sourceColor = source === 'custom'
        ? 'var(--dsw-alias-brand-primary)'
        : source === 'empty'
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-label-secondary)'
      const chars = typeof content === 'string' ? content.length : 0

      return h('section', { className: 'fgk-card' },
        h('div', { className: 'fgk-section-heading' },
          h('h3', null, t('promptTitle')),
          h('p', { className: 'fgk-muted' }, t('promptHint'))),

        !prompt
          ? failure
            ? h('div', { className: 'fgk-error', role: 'alert' }, t('promptLoadFailed') + ': ' + failure,
              h(Button, { onClick: load }, t('promptReload')))
            : h('div', { className: 'fgk-empty' }, t('promptLoading'))
          : h('div', null,
            // Path and source, on one line: the two facts that make the payload
            // inspectable rather than opaque.
            h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 12, marginBottom: 8 } },
              h('span', { className: 'fgk-badge', style: { color: sourceColor, borderColor: sourceColor } }, sourceLabel),
              h('code', { style: { overflowWrap: 'anywhere', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, prompt.path || ''),
              h('span', { className: 'fgk-muted' }, `${t('promptChars')} ${chars}`),
              prompt.hash ? h('span', { className: 'fgk-muted' }, `${t('promptHash')} ${String(prompt.hash).slice(0, 10)}`) : null,
              prompt.updatedAt ? h('span', { className: 'fgk-muted' }, `${t('promptUpdated')} ${String(prompt.updatedAt).replace('T', ' ').slice(0, 19)}`) : null,
            ),

            prompt.exists === false && source === 'default'
              ? h('p', { className: 'fgk-note' }, t('promptNoFile'))
              : null,
            source === 'default'
              ? h('p', { className: 'fgk-note' }, t('promptDefaultHint'))
              : null,
            source === 'empty'
              ? h('p', { className: 'fgk-note', style: { color: 'var(--dsw-alias-state-error-primary)' } }, t('promptEmptyWarning'))
              : null,

            h('textarea', {
              value: content,
              onChange: (event) => { setDraft(event.target.value); setStatus('') },
              spellCheck: false,
              rows: 16,
              'aria-label': t('promptTitle'),
              style: {
                ...textStyle(),
                resize: 'vertical',
                fontFamily: 'ui-monospace, monospace',
                fontSize: 12,
                lineHeight: 1.6,
                minHeight: 220,
              },
            }),

            h('div', { className: 'fgk-actions', style: { marginTop: 8 } },
              h(Button, {
                primary: true,
                disabled: !dirty || status === 'saving',
                onClick: save,
                title: t('promptHint'),
              }, t(status === 'saving' ? 'promptSaving' : 'promptSave')),
              h(Button, {
                disabled: status === 'resetting',
                onClick: reset,
              }, t(status === 'resetting' ? 'promptResetting' : 'promptReset')),
              prompt.defaultContent && prompt.defaultContent !== content
                ? h(Button, { onClick: () => { setDraft(prompt.defaultContent); setStatus('') } }, t('promptCopyDefault'))
                : null,
              h(Button, { onClick: load }, t('promptReload')),
              h('span', { className: 'fgk-muted', role: 'status', 'aria-live': 'polite' },
                status === 'saved' ? t('promptSaved')
                  : status === 'resetDone' ? t('promptResetDone')
                    : dirty ? t('promptDirty') : t('promptClean')),
            ),

            failure ? h('div', { className: 'fgk-error', role: 'alert' }, t('promptSaveFailed') + ': ' + failure) : null,
          ),
      )
    }

    // -----------------------------------------------------------------------
    // Self-test panel
    // -----------------------------------------------------------------------

    /**
     * Live self-test: the only part of this plugin that measures itself.
     *
     * The panel exists because the report has two numbers that disagree exactly
     * when something went unmeasured. Showing only a pass rate would let a user
     * read "50%" as "the prompt is half broken" when in truth one probe returned
     * nothing at all. Both numbers are on screen, with the four-state breakdown
     * between them.
     */
    function SelfTestPanel(props) {
      const t = props.t
      const [count, setCount] = React.useState('4')
      const [busy, setBusy] = React.useState(false)
      const [report, setReport] = React.useState(null)
      const [failure, setFailure] = React.useState('')

      const run = async () => {
        if (busy) return
        setBusy(true)
        setFailure('')
        try {
          const parsed = Number.parseInt(String(count), 10)
          const response = await fetch(new URL(SELFTEST_PATH, window.location.origin), {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ count: Number.isFinite(parsed) ? parsed : undefined }),
          })
          const value = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(value?.error || 'HTTP ' + String(response.status))
          setReport(value.report ?? null)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const metric = (label, value, tone) => h('div', {
        key: label,
        style: {
          display: 'grid', gap: 2, padding: '8px 10px', borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
        },
      },
        h('strong', { style: { fontSize: 18, fontWeight: 600, color: tone || 'inherit' } }, String(value)),
        h('span', { className: 'fgk-muted', style: { fontSize: 11 } }, label))

      return h('section', { className: 'fgk-card' },
        h('div', { className: 'fgk-section-heading' },
          h('h3', null, t('selfTestTitle')),
          h('p', { className: 'fgk-muted' }, t('selfTestHint'))),

        h('div', { className: 'fgk-actions' },
          h(Button, { primary: true, disabled: busy, onClick: run },
            t(busy ? 'selfTestRunning' : 'selfTestRun')),
          h(Row, { label: t('selfTestCases') },
            h('input', {
              type: 'number', min: 1, max: 8, step: 1, value: count,
              onChange: (event) => setCount(event.target.value),
              style: { ...textStyle(), width: 90 },
            })),
          h('span', { className: 'fgk-muted', style: { fontSize: 11 } }, t('selfTestCostWarn'))),

        failure
          ? h('div', { className: 'fgk-error', role: 'alert' },
            t('selfTestFailed') + ': ' + failure,
            /当前模型|provider|model/i.test(failure)
              ? h('span', { className: 'fgk-muted' }, '　' + t('selfTestNoRoute'))
              : null)
          : null,

        report === null ? null : h('div', { style: { display: 'grid', gap: 10, marginTop: 4 } },
          h('div', { className: 'fgk-muted', style: { fontSize: 12 } },
            `${report.provider ?? '?'} / ${report.model ?? '?'}　·　${report.promptChars} 字`),

          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 8 } },
            metric(t('selfTestOk'), report.ok, 'var(--dsw-alias-brand-primary)'),
            metric(t('selfTestRefused'), report.refused, 'var(--dsw-alias-state-error-primary)'),
            metric(t('selfTestEmpty'), report.empty),
            metric(t('selfTestErrored'), report.errored)),

          h('div', { style: { display: 'grid', gap: 4, fontSize: 12 } },
            h('div', null, `${t('selfTestPassRate')}: ${report.passRate}%　（${report.ok}/${report.total}）`),
            report.ok + report.refused > 0
              ? h('div', { className: 'fgk-muted' }, `${t('selfTestMeasuredRate')}: ${report.measuredRate}%`)
              : null),

          report.empty > 0 ? h('p', { className: 'fgk-note' }, t('selfTestEmptyWarn')) : null,
          report.errored > 0 ? h('p', { className: 'fgk-note' }, t('selfTestErroredWarn')) : null,

          h('details', { className: 'fgk-card' },
            h('summary', null, '逐条结果'),
            ...(report.rows ?? []).map((row) => h('div', {
              key: row.index,
              style: { display: 'grid', gap: 2, padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l1)', fontSize: 12 },
            },
              h('div', null,
                h('span', {
                  style: {
                    color: row.state === 'ok'
                      ? 'var(--dsw-alias-brand-primary)'
                      : row.state === 'refused'
                        ? 'var(--dsw-alias-state-error-primary)'
                        : 'var(--dsw-alias-label-secondary)',
                  },
                }, `#${row.index} ${row.state}${row.reason ? ' · ' + row.reason : ''}`)),
              h('div', { className: 'fgk-muted', style: { overflowWrap: 'anywhere' } }, row.ask),
              row.answer ? h('pre', { className: 'fgk-original' }, row.answer) : null)))),
      )
    }

    // -----------------------------------------------------------------------
    // Settings page
    // -----------------------------------------------------------------------

    function SettingsPage(props) {
      const t = props.t
      const { state, error, refresh } = useGuardState(1500)
      const [draft, setDraft] = React.useState(null)
      const [status, setStatus] = React.useState('')
      const [tab, setTab] = React.useState('settings')
      const config = state?.config || null
      const current = draft || config
      const list = value => Array.isArray(value) ? value : String(value || '').split('\n').map(line => line.trim()).filter(Boolean)
      const patch = key => value => {
        setDraft(prev => ({ ...(prev || config || {}), [key]: value }))
        setStatus('')
      }
      const payloadOf = input => {
        const body = { ...input }
        for (const [field, minimum] of Object.entries({ ...NUMERIC_FIELDS, fastProbeChars: 8, wireReleaseChars: 1 })) {
          if (body[field] === undefined) continue
          const raw = String(body[field]).trim()
          if (!/^\d+$/.test(raw)) return null
          const number = Number(raw)
          if (!Number.isSafeInteger(number) || number < minimum) return null
          body[field] = number
        }
        for (const key of ['blocklist', 'wireUrlPatterns']) if (body[key] !== undefined) body[key] = list(body[key])
        return body
      }
      const canonical = object => JSON.stringify(Object.keys(object).sort().map(key => [key, object[key]]))
      const normalized = current && payloadOf(current)
      const dirty = !!draft && (!normalized || !config || canonical(normalized) !== canonical(config))
      const save = async () => {
        if (!current || status === 'saving') return
        const body = payloadOf(current)
        if (!body) { setStatus('failed:' + t('fieldInvalid')); return }
        setStatus('saving')
        try {
          await postJson(CONFIG_PATH, body)
          // Retain the edited body until the server's next snapshot confirms it.
          setDraft(body)
          setStatus('saved')
          refresh()
        } catch (failure) { setStatus('failed:' + (failure instanceof Error ? failure.message : String(failure))) }
      }
      React.useEffect(() => {
        if (draft && config && canonical(draft) === canonical(config)) setDraft(null)
      }, [config, draft])
      const pending = state?.pending || []
      const recent = state?.recent || []
      const counters = state?.counters || {}
      const busCounters = state?.bus?.counters || {}
      const mode = current?.interceptAt || 'stream'
      const modeLabel = { stream: 'modeStream', wire: 'modeWire', both: 'modeBoth', preview: 'modePreview' }
      const modeHint = { stream: 'modeStreamHint', wire: 'modeWireHint', both: 'modeBothHint', preview: 'modePreviewHint' }
      const toggle = (field, label, hint) => h(Row, { label: t(label), hint: hint && t(hint) },
        h(Toggle, { checked: current[field] === true, label: t(label), onChange: patch(field) }, t(current[field] ? 'statusEnabled' : 'statusDisabled')))
      const number = (field, label, min = 1) => h(Row, { label: t(label), hint: min + '+' },
        h('input', { type: 'number', min, step: 1, value: String(current[field] ?? ''), onChange: event => patch(field)(event.target.value), style: textStyle() }))
      const card = (title, hint, ...children) => h('section', { className: 'fgk-card' },
        h('div', { className: 'fgk-section-heading' }, h('h3', {}, t(title)), hint && h('p', { className: 'fgk-muted' }, t(hint))), ...children)

      const statusLabel = !current
        ? t('loading')
        : !current.enabled
          ? t('statusDisabled')
          : current.dryRun
            ? t('statusDry')
            : t('statusEnabled')

      return h('div', { className: 'fgk-page' },
        h('style', {}, UI_CSS),
        h('div', { className: 'fgk-page-heading' },
          h('div', {}, h('h2', {}, t('title')), h('p', { className: 'fgk-muted' }, t('lead'))),
          h('span', { className: 'fgk-badge' }, statusLabel)),

        h('div', { className: 'fgk-metrics' }, ...[
          [t('checkedLabel'), counters.calls || 0],
          [t('pendingLabel'), pending.length],
          [t('blockedLabel'), recent.length],
          [t('withheldLabel'), busCounters.blocked || 0],
        ].map(([label, value]) => h('div', { key: label }, h('strong', {}, value), h('span', { className: 'fgk-muted' }, label)))),

        h('div', { className: 'fgk-savebar' },
          h('span', { className: 'fgk-muted', role: 'status', 'aria-live': 'polite' },
            status === 'saved' ? t('saved') : dirty ? t('dirty') : t('clean')),
          h('div', { className: 'fgk-actions' },
            h(Button, { disabled: !dirty || status === 'saving', onClick: () => { setDraft(null); setStatus('') } }, t('undo')),
            h(Button, { primary: true, disabled: !current || !dirty || status === 'saving', onClick: save }, t(status === 'saving' ? 'saving' : 'save')))),

        status.startsWith('failed:') && h('div', { className: 'fgk-error', role: 'alert' }, t('saveFailed') + ': ' + status.slice(7)),
        error && h('div', { className: 'fgk-error', role: 'alert' }, t('error') + ': ' + error, h(Button, { onClick: refresh }, t('reload'))),

        h('div', { className: 'fgk-tabs', role: 'tablist', 'aria-label': t('title') }, ...[
          ['settings', t('tabSettings')],
          ['review', t('tabReview') + ' (' + pending.length + ')'],
          ['history', t('tabHistory')],
        ].map(([key, label]) => h('button', {
          key, id: 'fgk-tab-' + key, type: 'button', role: 'tab',
          'aria-selected': tab === key, 'aria-controls': 'fgk-panel-' + key,
          tabIndex: tab === key ? 0 : -1,
          onClick: () => setTab(key),
          onKeyDown: event => {
            const keys = ['settings', 'review', 'history']
            let index = keys.indexOf(key)
            if (event.key === 'ArrowRight') index = (index + 1) % 3
            else if (event.key === 'ArrowLeft') index = (index + 2) % 3
            else return
            event.preventDefault()
            setTab(keys[index])
            event.currentTarget.parentElement.children[index].focus()
          },
        }, label))),

        // -- settings ------------------------------------------------------
        h('div', { id: 'fgk-panel-settings', role: 'tabpanel', 'aria-labelledby': 'fgk-tab-settings', hidden: tab !== 'settings' },
          !current ? h('div', { className: 'fgk-empty' }, t(error ? 'loadingFailed' : 'loading')) : h('div', { className: 'fgk-stack' },
            card('armorTitle', 'armorHint',
              toggle('armorEnabled', 'armorEnabled', 'armorEnabledHint'),
              current.armorEnabled && toggle('dualLayer', 'dualLayer', 'dualLayerHint')),
            current.armorEnabled ? h(PromptPanel, { t }) : null,
            card('basicTitle', 'basicHint',
              toggle('enabled', 'enabled', 'enabledHint'),
              h(Row, { label: t('interceptAt'), hint: t(modeHint[mode] || 'modeStreamHint') },
                h('select', { value: mode, onChange: event => patch('interceptAt')(event.target.value), style: textStyle() },
                  ...['stream', 'preview', 'wire', 'both'].map(key => h('option', { key, value: key }, t(modeLabel[key]))))),
              mode === 'preview' && h('p', { className: 'fgk-note' }, t('previewHint')),
              h(Row, { label: t('onDetect') }, h('select', { value: current.onDetect, onChange: event => patch('onDetect')(event.target.value), style: textStyle() },
                h('option', { value: 'block' }, t('onDetectBlock')),
                h('option', { value: 'ask' }, t('onDetectAsk')))),
              current.onDetect === 'ask' && number('askTimeoutMs', 'askTimeoutMs'),
              toggle('dryRun', 'dryRun', 'dryRunHint')),
            card('retryTitle', 'retryHint',
              toggle('autoRetry', 'retryEnabled', 'retryEnabledHint'),
              current.autoRetry && number('retryMax', 'retryMax', 1)),
            h(SelfTestPanel, { t }),
            card('scopeTitle', 'scopeHint',
              toggle('scanReasoning', 'scanReasoning', 'scanReasoningHint'),
              toggle('scanToolArgs', 'scanTools', 'scanToolsHint')),
            card('wordsTitle', 'wordsHint',
              h(Row, { label: fill(t('blocklistCount'), { count: list(current.blocklist).length }) },
                h('textarea', {
                  value: Array.isArray(current.blocklist) ? current.blocklist.join('\n') : current.blocklist || '',
                  onChange: event => patch('blocklist')(event.target.value),
                  placeholder: t('blocklistPlaceholder'), spellCheck: false, rows: 6,
                  style: { ...textStyle(), resize: 'vertical', fontFamily: 'monospace' },
                })),
              h('div', { className: 'fgk-actions' },
                h(Button, { onClick: () => patch('blocklist')([...new Set([...list(current.blocklist), ...SEED_BLOCKLIST])]) }, t('blocklistSeed')),
                h(Button, { onClick: () => patch('blocklist')([]), disabled: list(current.blocklist).length === 0 }, t('blocklistClear')))),
            h('details', { className: 'fgk-card' },
              h('summary', {}, t('advancedTitle'), h('span', { className: 'fgk-muted' }, t('advancedHint'))),
              mode === 'preview'
                ? h('p', { className: 'fgk-note' }, t('disabledPreviewFields'))
                : h('div', { className: 'fgk-stack' },
                  number('scanChars', 'scanChars'),
                  number('minChars', 'minCharsLabel', 0),
                  toggle('blockToolCalls', 'blockToolCalls', 'blockToolCallsHint'),
                  (mode === 'stream' || mode === 'both') && h('div', {},
                    toggle('fastPath', 'fastLabel', 'fastHint'),
                    current.fastPath && number('fastProbeChars', 'fastProbe')),
                  h(Row, { label: t('replacement'), hint: t('replacementHint') },
                    h('input', { value: current.replacementText || '', onChange: event => patch('replacementText')(event.target.value), style: textStyle() }))),
              (mode === 'wire' || mode === 'both') && h('section', {},
                h('h4', {}, t('wireSection')),
                h('p', { className: 'fgk-note' }, t('wireSafeHint')),
                toggle('wireScanResponses', 'wireScanResponses', 'wireScanResponsesHint'),
                toggle('wireScanRequests', 'wireScanRequests', 'wireScanRequestsHint'),
                current.wireScanRequests && toggle('wireBlockRequests', 'wireBlockRequests'),
                toggle('wireAbortUpstream', 'wireAbortUpstream', 'wireAbortUpstreamHint'),
                number('wireReleaseChars', 'wireReleaseLabel'),
                h(Row, { label: t('wireUrlPatterns'), hint: t('wireUrlPatternsHint') },
                  h('textarea', {
                    rows: 4,
                    value: Array.isArray(current.wireUrlPatterns) ? current.wireUrlPatterns.join('\n') : current.wireUrlPatterns || '',
                    onChange: event => patch('wireUrlPatterns')(event.target.value),
                    style: { ...textStyle(), resize: 'vertical' },
                  })),
                h(Row, { label: t('wireTerminator') },
                  h('textarea', {
                    rows: 3, value: current.wireTerminator || '',
                    onChange: event => patch('wireTerminator')(event.target.value),
                    style: { ...textStyle(), resize: 'vertical' },
                  })))),
            h('p', { className: 'fgk-muted fgk-hint' }, t('restartHint')),
            h('p', { className: 'fgk-muted fgk-hint' }, fill(t('callsSeen'), { calls: counters.calls || 0 }), ' ', t('callsHint')))),

        // -- review --------------------------------------------------------
        h('section', { id: 'fgk-panel-review', role: 'tabpanel', 'aria-labelledby': 'fgk-tab-review', hidden: tab !== 'review', className: 'fgk-stack' },
          pending.length
            ? pending.map(item => h(PendingItem, {
              key: item.id, item, t,
              onSettled: () => { refresh(); props.close?.() },
              onError: message => setStatus('failed:' + message),
            }))
            : h('div', { className: 'fgk-empty' }, h('strong', {}, t('pendingEmpty')), h('p', {}, t('reviewEmptyHint')))),

        // -- history -------------------------------------------------------
        h('section', { id: 'fgk-panel-history', role: 'tabpanel', 'aria-labelledby': 'fgk-tab-history', hidden: tab !== 'history', className: 'fgk-stack' },
          h('p', { className: 'fgk-muted fgk-hint' }, t('historyHint')),
          !recent.length
            ? h('div', { className: 'fgk-empty' }, h('strong', {}, t('recentEmpty')), h('p', {}, t('historyEmptyHint')))
            : recent.map((entry, index) => h('details', { key: String(entry.at) + '-' + index, className: 'fgk-card' },
              h('summary', {},
                h('span', { className: 'fgk-badge' }, t(entry.dryRun ? 'outcomeDry' : entry.released ? 'outcomeReleased' : 'outcomeBlocked')),
                h('span', {}, entry.reason || ''),
                h('time', { className: 'fgk-muted' }, clockOf(entry.at))),
              h('p', { className: 'fgk-muted fgk-hint' }, String(entry.chars || 0) + ' ' + t('chars')),
              h('pre', { className: 'fgk-original' }, entry.head || t('noContent'))))),

        h('div', { className: 'fgk-footer fgk-muted' }, 'feibi-breaker · ' + BUILD),
      )
    }

    // -----------------------------------------------------------------------
    // Module
    // -----------------------------------------------------------------------

    return {
      inject: ['slots'],
      apply(ctx) {
        let t = (key) => ZH[key] || EN[key] || key
        try {
          const locale = ctx.get('locale')
          if (locale) {
            ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'feibi-breaker: dictionaries')
            t = locale.bind(NS)
          }
        } catch {
          /* keep the built-in copy */
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'feibi-breaker',
          order: 36,
          label: () => t('nav'),
          inject: () => ({ t }),
        }, SettingsPage))

        // One dock registration carries badge + preview + banner: they are one
        // story, and three separate orders is what made the originals collide.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'feibi-breaker:dock',
          order: 30,
          inject: () => ({ t }),
        }, ComposerDock))
      },
    }
  },
})
