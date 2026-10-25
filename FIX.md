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
