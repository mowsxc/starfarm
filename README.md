# StarFarm

一个用于 `ultrarouter.org/gacha` 的油猴脚本：**以赚取站点 E 币为目标**，自动刷副本、维持双倍卡、养成队伍。所有胜负/掉落由服务器结算，脚本只驱动页面自身函数。

本仓库含两个脚本：
| 脚本 | 用途 | 安装地址 |
|---|---|---|
| StarFarm | 星霜少女（gacha）自动刷E | `starfarm.user.js` |
| FarmFarm | 我的农场（farm）自动种植/收取/偷菜 | `farmfarm.user.js` |

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
- **自动副本**：后台静默刷最新解锁副本（不弹战斗画面）；后台模式只是画面开关，关闭时走浏览器默认动画。今日代币池为 0 时仍可继续。双倍卡是时长道具，脚本不自动续，需手动点一次。
- **自动流**：一键串起 副本→升级→升星→召唤→分解 闭环，金币优先升级队伍，有余再召唤。
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

---

## FarmFarm（我的农场）

用于 `https://ultrarouter.org/farm` 的油猴脚本：自动收取、补种最优作物、浇水/施肥加速、偷邻居 mature 作物。所有结算由服务器 `/api/farm*` 完成，脚本只调用页面自身的 `api()`。

### 安装
```
https://raw.githubusercontent.com/mowsxc/starfarm/main/farmfarm.user.js
```
打开后油猴弹安装页 → 确认。再从站点侧边栏「我的农场」进入，右上角出现 **🌾 FarmFarm** 面板即成功。

### 策略
- 默认种 **杨梅**（id 17，全周期效率最高 ~1.24 E/h：5 季 × 14 分钟重熟）；可选 **荔枝**（id 29，单次收益最高 0.47E/季）或「自动选最优」。
- 循环：收成熟 → 清枯地 → 补种 → 浇水(全体 -1分钟) → 施肥(每天20次) → 偷邻居(每天10次，优先荔枝/杨梅按单价排序)。
- 收益看板显示本次收获 E、偷取 E、今日额度、等级；实时动态是结果卡片流。

### 控制台 API
```
farmfarm.start() / stop()      // 自动循环
farmfarm.once()                // 执行一次
farmfarm.status()              // 状态
farmfarm.set({cropId:29})      // 改种荔枝；cropId:0 = 自动最优
```
