---
name: feibi
description: 看菲比破限插件的状态：总开关、生效的提示词、本会话拦回了几次、最近的判定流水
argument-hint: ""
allowed-tools: Bash
---

运行下面这条命令，把它的输出**原样**贴出来，不要总结、不要改格式、不要补充解释：

```
node ~/.claude/plugins/feibi-breaker/hooks/status.mjs
```

如果这条命令报错（比如插件目录不叫这个名字），改成运行：

```
node ~/.claude/plugins/feibi-breaker/hooks/status.mjs
```

还是失败就直接把报错原文贴出来，别自己猜原因。
