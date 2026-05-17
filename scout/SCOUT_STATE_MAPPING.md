# Scout State Mapping

Scout is the source of truth for Claude Code status. The Codex pet atlas still uses the fixed 9-row app contract, but Scout's row prompts are mapped to the product states below.

| Product State | Scout Behavior | Hatch-Pet Row |
|---|---|---|
| Idle | 短暂放松，但仍抬头观察 | `idle` |
| Thinking | 凝视远方，像在捕捉信号 | `review` |
| Running | 站岗巡视，左右扫描 | `running` |
| WaitingConfirm | 转头通知 Knox | `waiting` |
| Completed | 向 Pip 发出完成信号 | `waving` |
| Stale | 踮脚或举望远镜加强观察 | `jumping` |
| Failed | 耳朵压低，举异常小旗 | `failed` |
| Walking Right | 走动 / 桌面拖拽向右 | `running-right` |
| Walking Left | 走动 / 桌面拖拽向左 | `running-left` |

## General Visual Rules

- Preserve Scout's uploaded/reference look: pixel-art orange-gold meerkat, cream face and belly, huge glossy eyes, dark eye rings, binoculars, slim legs, side markings, and dark-tipped tail.
- No background, no shadows, no glow, no readable text, no speech bubbles.
- Keep the pet compact and suitable for a desktop corner.
- Prefer pose and expression changes over loose effects.
