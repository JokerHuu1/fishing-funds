<p align="center">
<img src="https://github.com/1zilc/fishing-funds/blob/main/build/icon.png?raw=true" width="128">
</p>

# Fishing Funds

## 修复说明

> [!IMPORTANT]
> **这是 [`1zilc/fishing-funds`](https://github.com/1zilc/fishing-funds) v8.7.1 的个人修复分支，非官方版本。**

上游自 v8.8.0 起把接口层抽到了私有子模块（`fishing-funds-enh`），而旧版依赖的天天基金 JSONP 估值接口
`fundgz.1234567.com.cn` 已下线，基金列表因而整片为空。本分支改用天天基金新版批量估值接口，
恢复了基金列表、盘中估值、持仓与指数行情。

故障原因、新接口对照、改动清单、构建方式与已知限制见 [FIX.md](FIX.md)。

### 参考的开源项目

本次修复在调研与实现过程中参考了以下项目，在此致谢：

| 项目 | 作者 | 许可证 | 参考内容 |
| --- | --- | --- | --- |
| [real-time-fund](https://github.com/hzm0321/real-time-fund) | [hzm0321](https://github.com/hzm0321) | AGPL-3.0 | `FundValuationLast` 批量估值接口的可用字段、50 只/批的请求方式、`GZTIME` 时间格式的处理 |
| [FundVal-Live](https://github.com/Ye-Yu-Mo/FundVal-Live) | [Ye-Yu-Mo](https://github.com/Ye-Yu-Mo) | AGPL-3.0 | `FundMNFInfo` / `FundMNInverstPosition` 移动端接口及其 iOS 通道参数（`plat=Iphone`、`version=6.2.8`、UUID 形式的 `deviceid`、iPhone UA），以及 `fundgz` 于 2026-07-29 起失效的判断 |

调研阶段还查阅了 [x2rr/funds](https://github.com/x2rr/funds)（GPL-3.0）等同类项目，仅用于了解历史接口的迁移情况，未采用其实现。

**关于代码来源与许可证**：上述项目仅作为接口用法与排查思路的参考——接口地址、请求参数、字段名称属于事实性信息；
本分支的实现是按本项目自身架构重写的（见 `src/renderer/services/fund.ts`、`src/renderer/helpers/fund.ts`），
**没有复制上述项目的源代码**。若后续引入其中代码，将按 AGPL-3.0 / GPL-3.0 的要求保留版权声明并注明来源。

本分支沿用上游的 [GPL-3.0](LICENSE) 许可证，原作者与版权归 [1zilc](https://github.com/1zilc) 所有；修改文件与日期见 [FIX.md](FIX.md#七修改记录)。

![GitHub release (latest by date)](https://img.shields.io/github/v/release/1zilc/fishing-funds)
![GitHub Release Date](https://img.shields.io/github/release-date/1zilc/fishing-funds)
![GitHub all releases](https://img.shields.io/github/downloads/1zilc/fishing-funds/total)
[![Codacy Badge](https://api.codacy.com/project/badge/Grade/ee4fd509a7184f738eeb9048959b1f56)](https://app.codacy.com/gh/1zilc/fishing-funds?utm_source=github.com&utm_medium=referral&utm_content=1zilc/fishing-funds&utm_campaign=Badge_Grade_Settings)
[![Build](https://github.com/1zilc/fishing-funds/actions/workflows/publish.yml/badge.svg?branch=main)](https://github.com/1zilc/fishing-funds/actions/workflows/publish.yml)
![GitHub top language](https://img.shields.io/github/languages/top/1zilc/fishing-funds?color=red)
![GitHub package.json dependency version (dev dep on branch)](https://img.shields.io/github/package-json/dependency-version/1zilc/fishing-funds/dev/electron/main)
![Sandbox](https://img.shields.io/badge/sandbox-yes-blueviolet)
![GitHub](https://img.shields.io/github/license/1zilc/fishing-funds)
![Windows](https://img.shields.io/badge/-Windows-blue?logo=windows&logoColor=white)
![MacOS](https://img.shields.io/badge/-macOS-black?&logo=apple&logoColor=white)
![Linux](https://img.shields.io/badge/-Linux-yellow?logo=linux&logoColor=white)

> 基金,大盘,股票,虚拟货币状态栏显示小应用,基于 Electron 开发,支持 MacOS,Windows,Linux 客户端

## 项目介绍

- 实时显示当前基金涨跌情况，计算显示收益，大盘实时数据，板块行情，股票走势，加密虚拟货币等
- 软件中所有的数据仅供参考，一切收益或是亏损按当天实际为准，任何走势，排行数据均来自于第三方网站不代表作者观点
- 软件不收集上传ai相关功能的用户apikey，如有疑问请忽略ai功能
- 本项目是个人自用状态栏小插件，完全开源免费，仅供学习交流

## 下载使用

安装包见本仓库的 [Releases](https://github.com/JokerHuu1/fishing-funds/releases) 页面（Windows 安装程序、macOS Apple 芯片 / Intel 各一个）。

> 注意 ⚠️：本分支的 macOS 包未签名、未公证，系统默认不允许打开，首次运行请执行以下任一操作

```bash
# 终端执行
sudo xattr -d com.apple.quarantine "/Applications/Fishing Funds.app"
```

```bash
# 安全设置
进入 「设置」- 「安全性与隐私」- 「通用」- 「允许从以下位置下载的App」-「仍然打开」
```

## AI

FIshing Funds 支持 OpenAI Compatibility 接口用于基金一键录入等，不会收集上传用户 apikey，如有疑问请忽略 ai 相关功能

- 基金导入（推荐模型 Grok4、Gemini 2.5 pro、 Qwen2.5vl:32b 及以上）

## 系统代理

- 由于众所周知的原因，部分货币接口无法访问，Fishing Funds 已适配系统代理访问
- 支持 http 代理、socks 代理
- 自行将以下货币接口加入自己的代理软件规则中，并重启 Fishing Funds

```
api.coingecko.com
api.coincap.io
```

## 导入导出

Fishing Funds 右键菜单支持导入导出基金 JSON 配置方便备份

```typescript
// 字段说明
interface FundSetting {
  code: string; // 基金代码（必填）
  name?: string; // 基金名称
  cyfe?: number; // 持有份额
  cbj?: number; // 持仓成本价
}
```

例子：

```json
[
  {
    "code": "320007",
    "name": "诺按成长混合",
    "cyfe": 1000.0,
    "cbj": 1.6988
  },
  {
    "code": "161725",
    "name": "招商中证白酒指数(LOF)",
    "cyfe": 1000.0,
    "cbj": 1.4896
  }
]
```

## AI 识别录入
Fishing Funds支持AI识别截图导入数据，确保模型具有vision功能，推荐gpt-4o、grok4、gemini2.5-pro、qwen2.5vl:32b及更好的大模型。
> 注意 ⚠️：请确保接口地址的安全性，本软件不保证识别过程中的数据不会泄露至第三方，使用时请确保完全了解该功能

- 使用openai兼容接口，在设置-AI中配置请求地址与apikey
- 进入某宝-理财-总资产-我的资产-全部持有
- 长截图，保证暴露基金名称、持有收益、累计收益三项数据
  

## 配置同步

- 设置中开启后自动存储配置文件至指定路径，启动时优先读取该路径配置
- 通过 iCloud、OneDrive 等方式自动同步该文件至云端实现多台设备配置同步
- 支持钱包，基金，指数，板块，股票，货币，h5 配置同步

## 收录网站

- [柠檬精选](https://lemon.qq.com/lab/app/FishingFunds.html)
- [Electron Apps](https://www.electronjs.org/apps/fishing-funds)
- [MacWk](https://www.macwk.com/soft/fishing-funds)
- [Homebrew](https://formulae.brew.sh/cask/fishing-funds#default)
- [Awesome Mac](https://github.com/jaywcjlove/awesome-mac)
- [WinGet](https://github.com/microsoft/winget-pkgs)

## 感谢

- [Jr Prévost](https://github.com/3on)
- [electron-vite](https://github.com/alex8088/electron-vite)
- [menubar](https://github.com/maxogden/menubar)
- [Ant Design](https://github.com/ant-design/ant-design/)
- [ahooks](https://github.com/alibaba/hooks)
- [echarts](https://github.com/apache/echarts)
- [Remix Icon](https://github.com/Remix-Design/RemixIcon)

## 许可证

本分支沿用上游 [GPL-3.0](LICENSE) 许可证，原作者与版权归 [1zilc](https://github.com/1zilc) 所有。

本次修复参考的第三方项目及其许可证见上方[参考的开源项目](#参考的开源项目)；其中 [real-time-fund](https://github.com/hzm0321/real-time-fund)
与 [FundVal-Live](https://github.com/Ye-Yu-Mo/FundVal-Live) 为 AGPL-3.0，[x2rr/funds](https://github.com/x2rr/funds) 为 GPL-3.0。
本分支未包含其源代码，如后续引入需按对应许可证执行。
