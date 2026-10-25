# 修复说明：基金估值接口失效

本仓库基于 [`1zilc/fishing-funds`](https://github.com/1zilc/fishing-funds) **v8.7.1**，
修复了上游基金数据全部失效的问题。上游 v8.8.0 起接口层被抽到私有子模块 `fishing-funds-enh`，
无法直接编译使用，因此选择最后一个接口层完整开源的版本作为基线。

## 一、故障原因

天天基金下线了老版 JSONP 估值接口：

```
https://fundgz.1234567.com.cn/js/{code}.js   →  404
```

应用原本对每只基金逐个请求该接口获取盘中估值，接口下线后基金列表整片消失。
其余三个数据源（腾讯证券、蚂蚁基金 fund123、同花顺爱基金）也已停止提供估值服务。

## 二、新的数据接口

**主接口（批量，实测稳定）**

```
https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast
    ?FCODES=code1,code2,...&FIELDS=FCODE,SHORTNAME,GSZZL,GZTIME,GSZ,NAV,PDATE
```

单次最多 50 只，请求数从「N 只基金 N 次」降为「N 只基金 N/50 次」。

**兜底接口（主接口漏掉的代码）**

```
https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo
```

必须使用 iOS 通道参数（`plat=Iphone`、`version=6.2.8`、UUID 形式的 `deviceid`、
UA 带 `eastmoney/6.2.8`），Android 通道参数会直接报错。

**持仓**

```
https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition   （同样走 iOS 通道）
```

返回 `fundStocks` / `fundboods`，替代原来抓 HTML 表格的做法。

**场内基金（ETF/LOF）兜底**

```
https://push2.eastmoney.com/api/qt/stock/get
```

## 三、改动清单

| 文件 | 改动 |
| --- | --- |
| `src/renderer/services/fund.ts` | 估值、持仓、行业接口全部重写；新增批量请求与拆分逻辑 |
| `src/renderer/helpers/fund.ts` | 批量拉取；无估值基金降级展示最新净值；修正估值日期判断 |
| `src/renderer/components/Toolbar/SettingContent/index.tsx` | 数据源选项收敛为「东方财富-天天基金」 |
| `release/app/package.json` | 版本号 8.8.1，避免自动更新覆盖本修复 |

另外顺手修复了今日榜单接口 Referer 少写一个 `h` 的笔误
（`ttp://fund.eastmoney.com/` → `https://fund.eastmoney.com/`）。

## 四、构建

```bash
npm install

# Windows 安装包（需在 macOS 上才能构建 macOS 目标）
npx electron-vite build
npx electron-builder build --win nsis --x64 -p never
```

## 五、已知限制

- **主动型基金在非交易时段没有盘中估值**：数据源本身的特性，官方网页同样显示 `--`，
  本分支会退化为「展示最新净值 + 涨幅留空」，不会让整行消失。
- QDII、部分 FOF 在部分时段同样取不到估值，表现同上。
- 估值数据仅供学习参考，实际收益以基金公司公布净值为准。

## 六、参考项目与开源合规

本次修复在调研与实现过程中参考了以下开源项目，在此致谢：

| 项目 | 作者 | 许可证 | 参考内容 |
| --- | --- | --- | --- |
| [hzm0321/real-time-fund](https://github.com/hzm0321/real-time-fund) | hzm0321 | [AGPL-3.0](https://github.com/hzm0321/real-time-fund/blob/main/LICENSE) | `FundValuationLast` 批量估值接口：可用字段列表（`FCODE,SHORTNAME,GSZZL,GZTIME,GSZ,NAV,PDATE`）、50 只/批的请求方式、`GZTIME` 秒级时间戳的截断处理 |
| [Ye-Yu-Mo/FundVal-Live](https://github.com/Ye-Yu-Mo/FundVal-Live) | Ye-Yu-Mo | [AGPL-3.0](https://github.com/Ye-Yu-Mo/FundVal-Live/blob/main/LICENSE) | `FundMNFInfo` / `FundMNInverstPosition` 移动端接口及 iOS 通道参数（`plat=Iphone`、`version=6.2.8`、UUID 形式的 `deviceid`、iPhone UA）；`fundgz` 自 2026-07-29 起返回 HTML 而非 JSONP 的结论 |
| [x2rr/funds](https://github.com/x2rr/funds) | x2rr | [GPL-3.0](https://github.com/x2rr/funds/blob/master/LICENSE) | 仅用于了解同类项目的接口迁移情况，未采用其实现 |

**代码来源声明**

- 上述项目仅作为接口用法与排查思路的参考。接口地址、请求参数、字段名称属于事实性信息，不构成受版权保护的表达。
- 本分支的实现按其自身架构重写：`src/renderer/services/fund.ts` 新增的 `RequestFundValuationLast`、
  `RequestFundInfoFromMobile`、`SplitCodes`、`GetFundValuations`，以及 `src/renderer/helpers/fund.ts`
  中的批量拉取与降级显示逻辑，均为本项目自行编写，**未复制上述项目的源代码**。
- 若后续从上述项目引入代码，须按对应许可证（AGPL-3.0 / GPL-3.0）保留版权声明、标注来源，
  并注意 AGPL-3.0 对网络服务提供的额外义务。

**本仓库的许可**

- 基于上游 `1zilc/fishing-funds` v8.7.1 修改，沿用其 [GPL-3.0](LICENSE) 许可证；
  原始版权归 [1zilc](https://github.com/1zilc) 所有，本分支的修改部分同样以 GPL-3.0 发布。
- 依据 GPL-3.0 第 5(a) 条，修改过的文件与日期见下一节。

## 七、修改记录

修改日期：2026-10（Windows 环境下完成修改与构建）

| 文件 | 修改内容 |
| --- | --- |
| `src/renderer/services/fund.ts` | 新增批量估值、移动端估值、持仓、行业接口；删除对已下线 `fundgz` 的依赖 |
| `src/renderer/helpers/fund.ts` | 批量拉取、无估值降级显示、估值日期判断 |
| `src/renderer/components/Toolbar/SettingContent/index.tsx` | 数据源选项收敛为天天基金 |
| `release/app/package.json` | 版本号 8.7.1 → 8.8.1 |
| `README.md`、`FIX.md`、`.gitignore` | 文档与忽略规则（非功能性改动） |

