---
name: feibi
description: 菲比破限设置与自检：默认打印面板；带参数时按子命令执行（doctor/models/ensure/set …），例如 /feibi doctor --fix
argument-hint: "[子命令或 key=value，例如 doctor --fix 或 strictness=max]"
allowed-tools: Bash
---

这是菲比破限的控制入口。按下面的规则执行，不要自己解释、不要改写输出格式。

**先判断参数：**

1. `$ARGUMENTS` 为空 → 只运行面板：

```
feibi-cc show
```

2. `$ARGUMENTS` 的第一个词是这些子命令之一（`doctor` / `ensure` / `models` / `status` / `statusline` / `show` / `set` / `start` / `stop` / `resume` / `bypass` / `panel`）→ **原样转发**：

```
feibi-cc $ARGUMENTS
```

3. 否则（形如 `strictness=max`、`forceModel=deepseek-v4.1-flash`、`inject=false`）→ 当作改配置：

```
feibi-cc set $ARGUMENTS
```

**跑完把命令输出原样贴出来**：不要总结、不要加评论、不要用 markdown 重排。

**`feibi-cc` 不在 PATH 上时**，把上面命令里的 `feibi-cc` 换成：

```
node "__FEIBI_BIN__"
```

（例：`node "__FEIBI_BIN__" doctor --fix`）

两条都跑不通就把报错原文贴出来，别猜原因。

**用户说"破限没效果 / 连不上 / 一直被拒 / 会话用不了"时**，先跑 `feibi-cc doctor`，把结果贴出来；只有确认要修才加 `--fix`。
