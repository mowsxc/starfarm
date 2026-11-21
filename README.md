# StarFarm

一个用于 `ultrarouter.org/gacha` 的油猴脚本：**以赚取站点 E 币为目标**，自动刷副本、维持双倍卡、养成队伍。所有胜负/掉落由服务器结算，脚本只驱动页面自身函数。

## 安装（Tampermonkey / Violentmonkey）

1. 安装油猴扩展。
2. 打开安装地址（raw 文件）：
   `https://raw.githubusercontent.com/mowsxc/starfarm/main/starfarm.user.js`
3. 浏览器会弹出脚本安装预览，点「确认安装」。
4. 打开 https://ultrarouter.org/gacha/ 并登录，右上角出现 **⭐ StarFarm E助手** 面板即成功。

## 更新

油猴会自动检查更新；也可在脚本管理页点「更新」。脚本头部含 `@updateURL` / `@downloadURL`，指向本仓库 raw 文件。

## 功能

- **E 收益看板**：E 总额、今日产出、本会话产出、场均 E、场次、今日副本数（六宫格）。
- **后台刷E**：后台静默刷最新解锁副本（不弹战斗画面），自动维持双倍卡使 E 产出翻倍；今日代币池为 0 时仍可继续。
- **队伍养成**（服务刷本）：升级满级、自动升星、分解多余碎片、自动镶嵌宝石、编队优化、自动召唤。
- **实时动态**：每场结算结果卡片（胜/负、星级、回合、掉落 +xE）与运行日志。

## 控制台 API

```
starfarm.status()            // 查看状态/E 收益/任务
starfarm.start('farm')       // 开始刷E（也可 level/star/decomp/gacha/gem）
starfarm.stop()              // 全部停止
starfarm.optimize()          // 一键编队优化
starfarm.analyze()           // 卡牌/副本分析表
starfarm.multi()             // 切换自动双倍卡
```

## 说明

- 脚本通过游戏页面的全局对象（`Store` / `SAVE` / `startRun` / `finishRun` / `mutate`）工作，不修改任何结算数据。
- 所有操作都带幂等键和串行队列，避免并发超时。
- 本脚本不包含「余额换币」「商店买金币」等消耗 E 的功能，避免本末倒置。
