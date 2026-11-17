---
name: feibi
description: 菲比破限设置面板：接线状态、开关、参数、最近判定；带参数时改配置（例如 /feibi strictness=max）
argument-hint: "[key=value ...]"
allowed-tools: Bash
---

这是菲比破限的设置入口。按下面顺序做，别自己解释、别改格式：

1. 如果用户带了参数（也就是 `$ARGUMENTS` 不为空），先运行：

```
feibi-cc set $ARGUMENTS
```

2. 然后运行：

```
feibi-cc show
```

3. 把 `feibi-cc show` 的输出**原样**贴出来。不要总结、不要加自己的评论、不要用 markdown 重新排版。

如果 `feibi-cc` 不在 PATH 上，改用：

```
node "__FEIBI_BIN__" show
```

（改配置同理：`node "__FEIBI_BIN__" set $ARGUMENTS`）

两条都跑不通就把报错原文贴出来，别猜原因。
