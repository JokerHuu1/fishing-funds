import { fromUint8Array } from 'js-base64';
import NP from 'number-precision';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import request from '@/utils/request';
import * as Utils from '@/utils';

/* -------------------------------------------------------------------------- */
/*                            基金实时估值（新接口）                            */
/* -------------------------------------------------------------------------- */
/**
 * 说明：
 * 天天基金已于 2025 年底下线 fundgz.1234567.com.cn 的 JSONP 估值接口
 * （请求会返回东方财富的 “页面未找到” HTML），导致基金列表整体为空。
 *
 * 现改用天天基金新版批量估值接口，一次请求可获取多只基金的名称/净值/估值：
 *   主接口：https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast
 *   备接口：https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo（iOS 通道）
 *
 * 无估值的基金（QDII、部分主动型基金）会退化为「仅展示最新净值」，
 * 等净值更新后由 GetFixFromEastMoney 修补。
 */
const FUND_VALUATION_URL = 'https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast';
const FUND_VALUATION_FIELDS = 'FCODE,SHORTNAME,GSZZL,GZTIME,GSZ,NAV,PDATE';
const FUND_VALUATION_BATCH_SIZE = 50;

const FUND_MOBILE_INFO_URL = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo';
const FUND_MOBILE_BATCH_SIZE = 100;
const FUND_MOBILE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 eastmoney/6.2.8',
};

// 移动端接口对 deviceid 有格式要求，模块加载时生成一个稳定的 uuid
const FUND_DEVICE_ID = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
  const random = (Math.random() * 16) | 0;
  const value = char === 'x' ? random : (random & 0x3) | 0x8;
  return value.toString(16);
});

/** 无估值时的占位文案，CalcFund 依赖该文案判断是否使用官方净值 */
export const NO_ESTIMATE_FLAG = '暂无估值';

/** 将接口返回的数字字段统一为 4 位/2 位小数字符串 */
function ToFixedString(value: unknown, digits = 4) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : undefined;
}

/** 把天天基金估值接口的原始条目转换为页面使用的结构 */
function ParseFundValuation(item: Record<string, any>): Fund.ResponseItem | undefined {
  const fundcode = item?.FCODE || item?.Fcode;
  if (!fundcode) {
    return undefined;
  }
  return {
    fundcode: String(fundcode),
    name: item.SHORTNAME ? String(item.SHORTNAME) : undefined,
    jzrq: item.PDATE ? String(item.PDATE) : undefined,
    dwjz: ToFixedString(item.NAV ?? item.DWJZ),
    gsz: ToFixedString(item.GSZ),
    gszzl: ToFixedString(item.GSZZL, 2),
    gztime: item.GZTIME ? String(item.GZTIME) : undefined,
  };
}

/** 主接口：批量估值（单次最多 50 只） */
async function RequestFundValuationLast(codes: string[]) {
  const result: Record<string, Fund.ResponseItem> = {};
  const { body } = await request<any>(FUND_VALUATION_URL, {
    searchParams: {
      FCODES: codes.join(','),
      FIELDS: FUND_VALUATION_FIELDS,
    },
    responseType: 'json',
  });
  const list: Record<string, any>[] = Array.isArray(body?.data) ? body.data : [];
  list.forEach((item) => {
    const fund = ParseFundValuation(item);
    if (fund?.fundcode) {
      result[fund.fundcode] = fund;
    }
  });
  return result;
}

/** 备接口：天天基金移动端（主接口不可用或缺少个别基金时兜底） */
async function RequestFundInfoFromMobile(codes: string[]) {
  const result: Record<string, Fund.ResponseItem> = {};
  const { body } = await request<any>(FUND_MOBILE_INFO_URL, {
    searchParams: {
      Fcodes: codes.join(','),
      pageIndex: 1,
      pageSize: 200,
      Sort: '',
      SortColumn: '',
      IsShowSE: 'false',
      P: 'F',
      deviceid: FUND_DEVICE_ID,
      plat: 'Iphone',
      product: 'EFund',
      version: '6.2.8',
    },
    headers: FUND_MOBILE_HEADERS,
    responseType: 'json',
  });
  const list: Record<string, any>[] = Array.isArray(body?.Datas) ? body.Datas : [];
  list.forEach((item) => {
    const fund = ParseFundValuation(item);
    if (fund?.fundcode) {
      result[fund.fundcode] = fund;
    }
  });
  return result;
}

function SplitCodes(codes: string[], size: number) {
  const chunks: string[][] = [];
  for (let index = 0; index < codes.length; index += size) {
    chunks.push(codes.slice(index, index + size));
  }
  return chunks;
}

/**
 * 批量获取基金估值/净值
 * @returns code -> 估值信息，未查询到的代码不会出现在结果中
 */
export async function GetFundValuationsFromEastMoney(codes: string[]) {
  const uniqueCodes = Array.from(
    new Set(
      (codes || [])
        .map((code) => String(code || '').trim())
        .filter(Boolean)
    )
  );
  const valuations: Record<string, Fund.ResponseItem> = {};
  if (!uniqueCodes.length) {
    return valuations;
  }

  try {
    const results = await Promise.allSettled(SplitCodes(uniqueCodes, FUND_VALUATION_BATCH_SIZE).map(RequestFundValuationLast));
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        Object.assign(valuations, result.value);
      }
    });
  } catch (error) {}

  // 主接口漏掉的代码用移动端接口补齐（也用于主接口整体异常时兜底）
  const missCodes = uniqueCodes.filter((code) => !valuations[code]);
  if (missCodes.length) {
    try {
      const results = await Promise.allSettled(SplitCodes(missCodes, FUND_MOBILE_BATCH_SIZE).map(RequestFundInfoFromMobile));
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          Object.assign(valuations, result.value);
        }
      });
    } catch (error) {}
  }

  return valuations;
}

/** 场内基金代码段，估值缺失时可用场内实时行情兜底 */
function IsExchangeTradedFund(code: string) {
  return /^(15|16|50|51|52|56|58)\d{4}$/.test(code);
}

/** 场内 ETF 实时行情（只取行情，不再回落到网页抓取） */
async function GetExchangeFundQuoteFromEastMoney(code: string) {
  try {
    const { body } = await request<any>('https://push2.eastmoney.com/api/qt/stock/get', {
      searchParams: {
        invt: 2,
        fltt: 1,
        fields: 'f43,f57,f58,f60,f86,f170',
        secid: `${/^(5|6)/.test(code) ? 1 : 0}.${code}`,
        wbp2u: '|0|0|0|web',
        _: Date.now(),
      },
      responseType: 'json',
    });
    const data = body?.data;
    if (!data?.f58 || !String(data.f58).toLowerCase().includes('etf')) {
      return undefined;
    }
    const preClose = Number(data.f60);
    const price = Number(data.f43 === '-' ? data.f60 : data.f43);
    if (!Number.isFinite(preClose) || !Number.isFinite(price)) {
      return undefined;
    }
    return {
      name: String(data.f58),
      dwjz: (preClose / 1000).toFixed(4),
      fundcode: code,
      gztime: dayjs(Number(data.f86) * 1000).format('YYYY-MM-DD HH:mm'),
      jzrq: `${new Date().getFullYear()}-昨收`,
      gsz: (price / 1000).toFixed(4),
      gszzl: ((Number(data.f170 === '-' ? 0 : data.f170) || 0) / 100).toFixed(2),
    } as Fund.ResponseItem;
  } catch (error) {
    return undefined;
  }
}

/** 无估值兜底：展示最新净值，涨跌幅留空，避免基金行整体消失 */
function BuildNoEstimateFund(fund: Fund.ResponseItem) {
  return {
    ...fund,
    gsz: fund.dwjz,
    gszzl: '',
    gztime: fund.gztime || `${new Date().getFullYear()}-${NO_ESTIMATE_FLAG}`,
  } as Fund.ResponseItem;
}

/**
 * 批量获取基金行情（估值 + 场内行情 + 无估值兜底），保持传入代码的顺序
 */
export async function GetFundResponsesFromEastMoney(codes: string[]) {
  const uniqueCodes = Array.from(
    new Set(
      (codes || [])
        .map((code) => String(code || '').trim())
        .filter(Boolean)
    )
  );
  const valuations = await GetFundValuationsFromEastMoney(uniqueCodes);

  // 无估值的场内基金（多为 QDII-ETF）用实时行情兜底
  const quoteCodes = uniqueCodes.filter((code) => valuations[code] && !valuations[code].gsz && IsExchangeTradedFund(code));
  if (quoteCodes.length) {
    const quotes = await Promise.all(quoteCodes.map((code) => GetExchangeFundQuoteFromEastMoney(code)));
    quotes.forEach((quote) => {
      if (quote?.fundcode && quote.gsz) {
        valuations[quote.fundcode] = quote;
      }
    });
  }

  return uniqueCodes.map((code) => {
    const fund = valuations[code];
    if (!fund) {
      return undefined;
    }
    return fund.gsz ? fund : BuildNoEstimateFund(fund);
  });
}

// 天天基金（单只基金，供新增/搜索等场景使用）
export async function FromEastmoney(code: string) {
  const [fund] = await GetFundResponsesFromEastMoney([code]);
  return fund;
}

// 腾讯证券
export async function FromTencent(code: string) {
  try {
    const {
      body: { data },
    } = await request<any>('https://web.ifzq.gtimg.cn/fund/newfund/fundSsgz/getSsgz', {
      searchParams: {
        app: 'web',
        symbol: `jj${code}`,
      },
      responseType: 'json',
    });
    const { yesterdayDwjz, code: status, data: list, date: gzrq } = data;
    if (status === -1) {
      return;
    }
    const [time, ssgsz] = list.pop();
    const { body } = await request(`https://gu.qq.com/jj${code}`, {
      responseType: 'text',
    });
    const $ = cheerio.load(body);
    const dwjz = yesterdayDwjz;
    const name = $('.title .col_1').text();
    const jzrq = $('#main3').text();
    const gsz = $('#main5').text() || ssgsz;
    const gzTime = `${time.slice(0, 2)}:${time.slice(2)}`;
    const gszzl = NP.times(NP.divide(NP.minus(gsz, dwjz), dwjz), 100).toFixed(2);

    return {
      name,
      dwjz,
      fundcode: code,
      gztime: `${gzrq} ${gzTime}`,
      jzrq,
      gsz,
      gszzl,
    };
  } catch (error) {
    return;
  }
}

// 支付宝-蚂蚁基金
export async function FromFund123(code: string) {
  try {
    const { body: html, headers } = await request(`https://www.fund123.cn/matiaria`, {
      responseType: 'text',
      searchParams: {
        fundCode: code,
      },
    });
    const $ = cheerio.load(html);
    const script = $('script').eq(2).html();
    const fixscript = script?.replace(/window\.context/g, 'const o');
    const context = eval(`(() => {
      ${fixscript}
      return o;
    })()`);
    const {
      csrf,
      materialInfo: {
        productId,
        fundCode,
        fundBrief: { fundNameAbbr },
        titleInfo: { netValue, netValueDate, dayOfGrowth },
      },
    }: {
      success: true;
      message: '请求成功';
      materialInfo: {
        productId: '20170808000230030000000000013513';
        fundCode: '002258';
        fundType: '混合型';
        titleInfo: {
          fundLimit: '0--';
          netValue: string; // '3.6580';
          netValueDate: '09-13';
          profitSevenDays: '--';
          profitTenThousand: '--';
          dayOfGrowth: '2.46';
          lastWeek: '5.88';
          riskEvaluation: '中高风险';
          establishmentDate: '2017-09-21';
          assetSize: '1.04亿';
          fundManagerName: '韩创';
        };
        fundBrief: {
          fundNameAbbr: '大成国企改革灵活配置混合';
          fundName: '大成国企改革灵活配置混合型证券投资基金';
          fundCode: '002258';
          establishmentDate: '2017-\n          09-\n          21';
          shareSize: '41784787.66';
          assetSize: '104651741.15';
          fundManagerName: '韩创';
          saleStatus: '正常申购';
          fundCompanyName: '大成基金管理有限公司';
          trusteeName: '中国银行股份有限公司';
          manageRate: '1.5%';
          trusteeRate: '0.25%';
          purchaseMinMount: '10.00';
          redeemMinMount: '1';
          purchaseRatio: '--';
          redeemRatio: '--';
          generalInfo: {
            fundName: '大成国企改革灵活配置混合型证券投资基金';
            establishmentDate: '2017-\n            09-\n            21';
            fundCode: '002258';
            assetSize: '104651741.15';
            fundCompanyName: '--';
            trusteeName: '中国银行股份有限公司';
            fundManagerBackground: '    韩创，中国国籍，金融学硕士，9年证券从业年限，具有基金从业资格。2012年6月至2015年6月曾任招商证券研究部研究员。2015年6月加入大成基金管理有限公司，历任研究部研究员、基金经理助理。2019年1月10日至2020年2月3日，担任大成消费主题混合型证券投资基金的基金经理。2019年1月10日起，担任大成新锐产业混合型证券投资基金的基金经理。2020年1月2日起，担任大成睿景灵活配置混合型证券投资基金的基金经理。2021年2月9日起，担任大成产业趋势混合型证券投资基金的基金经理。自2021年1月13日起，担任大成国企改革灵活配置混合型证券投资基金的基金经理。自2021年6月30日起，担任大成核心趋势混合型证券投资基金的基金经理。';
            fundManagerInfoList: [
              {
                key: '1';
                fundName: '大成新锐产业混合型证券投资基金';
                officeDate: '2019-01-10  至今';
                earnings: '3.979472';
              },
              {
                key: '2';
                fundName: '大成睿景灵活配置混合型证券投资基金A类';
                officeDate: '2020-01-02  至今';
                earnings: '2.241387';
              },
              {
                key: '3';
                fundName: '大成睿景灵活配置混合型证券投资基金C类';
                officeDate: '2020-01-02  至今';
                earnings: '2.201024';
              },
              {
                key: '4';
                fundName: '大成国企改革灵活配置混合型证券投资基金';
                officeDate: '2021-01-13  至今';
                earnings: '0.794896';
              },
              {
                key: '5';
                fundName: '大成产业趋势混合型证券投资基金A类';
                officeDate: '2021-02-09  至今';
                earnings: '0.448205';
              },
              {
                key: '6';
                fundName: '大成产业趋势混合型证券投资基金C类';
                officeDate: '2021-02-09  至今';
                earnings: '0.441500';
              },
              {
                key: '7';
                fundName: '大成核心趋势混合型证券投资基金C类';
                officeDate: '2021-06-30  至今';
                earnings: '0.225799';
              },
              {
                key: '8';
                fundName: '大成核心趋势混合型证券投资基金A类';
                officeDate: '2021-06-30  至今';
                earnings: '0.226099';
              }
            ];
            investPhilosophy: '    本基金的投资目标是通过投资于国企改革相关的优质上市公司，在严格控制风险的前提下，力争获取超越业绩比较基准的收益。';
            investStrategy: '    本基金通过对宏观经济环境、国家经济政策、股票市场风险、债券市场整体收益率曲线变化和资金供求关系等因素的分析，研判经济周期在美林投资时钟理论所处的阶段，综合评价各类资产的市场趋势、预期风险收益水平和配置时机。\r\n    本基金认为当前受益于国企改革的上市公司股票涉及多个行业，本基金将通过自下而上研究入库的方式，对各个行业中受益于国企改革主题的上市公司进行深入研究，并将这些股票组成本基金的核心股票库。\r\n    本基金将根据融资买入股票成本以及其他投资工具收益率综合评估是否采用融资方式买入股票，本基金在任何交易日日终持有的融资买入股票与直接买入股票市值之和，不得超过基金资产净值的95%。\r\n    本基金的债券投资采取稳健的投资管理方式，获得与风险相匹配的投资收益，以实现在一定程度上规避股票市场的系统性风险和保证基金资产的流动性。\r\n    中小企业私募债票面利率较高、信用风险较大、二级市场流动性较差。';
          };
        };
      };
      isLogin: false;
      csrf: 'GZiniT4s-CXuZczggNnZdY5lDoIb7ea5Jjho';
      isCloseEstimate: false;
      pageName: 'matiaria?fundCode=002258';
      uriBroker: {
        'favicon.ico.url': 'https://gw.alipayobjects.com/zos/rmsportal/mgPTSSvpLkKrsQwhoDzv.ico';
        'app.404.url': 'https://www.alipay.com/404.html';
        'zdrmdata.rest.url': 'http://zdrmdata-pool.gz00g.alipay.com';
        'app.errorpage.url': 'https://www.alipay.com/50x.html';
        'authcenter.url': 'https://auth.alipay.com';
        'app.goto.url': 'https://my.alipay.com/portal/i.htm';
        'bumng.url': 'https://bumng.alipay.com';
        'omeo.check.url': 'http://omeo-pool.gz00g.alipay.com';
        'omeo.get.url': 'https://omeo.alipay.com';
        'assets.url': 'https://gw.alipayobjects.com/a';
      };
    } = context;
    const cookies = headers as Record<string, string[]>['set-cookie'];
    const now = dayjs();
    const res = await request<{
      success: true;
      list: {
        bizSeq: 0;
        time: 1631583000000;
        forecastNetValue: string; //'4.22780306';
        forecastGrowth: string; //'-0.00662522';
      }[];
    }>(`https://www.fund123.cn/api/fund/queryFundEstimateIntraday`, {
      method: 'POST',
      searchParams: {
        _csrf: csrf,
      },
      headers: {
        'cookie': cookies?.join(''),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        startTime: now.format('YYYY-MM-DD'),
        endTime: now.add(1, 'day').format('YYYY-MM-DD'),
        limit: 200,
        productId: productId,
        format: true,
        source: 'WEALTHBFFWEB',
      }),
      responseType: 'json',
    });
    const { body } = res;
    const last = body.list.pop()!;
    const gzData = dayjs(last.time).format('MM-DD');
    let dwjz = netValue;

    if (netValueDate === gzData) {
      dwjz = String(NP.divide(netValue, NP.divide(NP.plus(100, dayOfGrowth), 100)));
    }
    const result = {
      name: fundNameAbbr,
      fundcode: fundCode,
      gztime: dayjs(last.time).format('YYYY-MM-DD HH:mm'),
      gsz: last.forecastNetValue,
      gszzl: (Number(last.forecastGrowth) * 100).toFixed(2),
      jzrq: `${now.year()}-${netValueDate}`,
      dwjz: dwjz,
    };

    return result;
  } catch (error) {
    return await GetQDIIFundFromFund123(code);
  }
}

// 同花顺-爱基金
export async function FromFund10jqka(code: string) {
  try {
    const { body } = await request<{
      data: [
        {
          code: '003834';
          enddate: '2021-09-30';
          type: 'nohbx';
          net: '3.8040';
          totalnet: '3.8040';
          ranges: '0.1330';
          rate: '3.62';
          net1: '3.6710';
          totalnet1: '3.6710';
          enddate1: '2021-09-29';
          mark: 'ths';
          updatetime: '211003024536';
          hqcode: 'JSH123';
          name: '华夏能源革新股票A';
          fundtype: '股票型';
          clrq: '2017-06-07';
          manager: '郑泽鸿';
          orgname: '华夏基金管理有限公司';
          dqlcqx: '-1';
          dqrq: '';
          sgstat: '限制大额';
          shstat: '开放';
          money: '50.0000';
          sgoldfl: '1.5';
          sgfl: '0.15';
          rgStart: '2017-05-04';
          rgEnd: '2017-06-02';
          rcsgStart: '2017-07-07';
          rcshStart: '2017-07-07';
          ifnew: 0;
          rgfl: '0.15';
          rgflold: '1.5';
          buy: '1';
          dt: '1';
          zkl: '0.1';
          zdsg: '10';
          nowyear: '40.73';
          week: '-5.89';
          month: '-9.10';
          tmonth: '12.64';
          year: '130.27';
          hyear: '55.84';
          tyear: '346.48';
          mz: '1.0000';
          themeList: [
            {
              field_name: '特斯拉';
              field_type: '概念';
              id: 'd0a32faf345dc75d9c7c8f2479f9224a';
            },
            {
              field_name: '三星';
              field_type: '概念';
              id: '5131c72b5ed2ef94eaca2675bc7c6f0d';
            }
          ];
          thsqbfl: '';
          jjgm: '66.35';
          levelOfRiskCode: '706003';
          levelOfRisk: '中风险';
          ifzj: '1';
          ifgz: '1';
          iszcg: '1';
          iszcz: '0';
          isfof: '0';
          asset: '224.10';
          fundBanner: [];
          showType: '1';
          rgStartReal: '2017-05-04';
          rgStartRealTime: '2017-05-04 00:00:00';
          rgEndRealTime: '2017-06-02 15:00:00';
          fastcash: '1';
          dqlc: 0;
          lcqx: '--';
          maxStar: '5';
          nowtime: 1633309917000;
        }
      ];
      error: {
        id: 0;
        msg: 'is access';
      };
    }>(`https://fund.10jqka.com.cn/data/client/myfund/${code}`, {
      responseType: 'json',
    });
    const data = body.data.pop()!;
    const now = new Date();
    const { body: script } = await request('https://gz-fund.10jqka.com.cn/', {
      responseType: 'text',
      searchParams: {
        module: 'api',
        controller: 'index',
        action: 'chart',
        info: `vm_fd_${data.hqcode}`,
        _: Date.now(),
        start: dayjs(now).format('MMDD'),
      },
    });

    const string = eval(`(()=>{
      const ${script};
      return vm_fd_${data.hqcode};
    })()`);

    const [info, _dwjz, gsinfo] = string.split('~');
    const gzdata = info.split('|').pop();

    const last: string = gsinfo.split(';').pop();
    const [time, gsz, dwjz, zero] = last.split(',');
    const gszzl = NP.divide(NP.minus(gsz, dwjz), dwjz, 0.01).toFixed(2);

    return {
      name: data.name,
      fundcode: data.code,
      gztime: `${gzdata} ${time.slice(0, 2)}:${time.slice(2)}`,
      gszzl: gszzl,
      jzrq: data.enddate,
      dwjz: data.net,
      gsz,
    };
  } catch (error) {
    return await GetQDIIFundFromFund10jqka(code);
  }
}

// 从天天基金获取估值图片
export async function GetEstimatedFromEastmoney(code: string) {
  try {
    const { body } = await request(`https://j4.dfcfw.com/charts/pic6/${code}.png`, {
      responseType: 'arraybuffer',
    });
    const b64encoded = fromUint8Array(new Uint8Array(body));
    return `data:image/png;base64,${b64encoded}`;
  } catch (error) {
    return;
  }
}

// 从天天基金获取投资风格图片
export async function GetInverstStyleFromEastmoney(code: string) {
  try {
    const { body } = await request(`https://j3.dfcfw.com/images/InvestStyle/${code}.png`, {
      responseType: 'arraybuffer',
    });
    const b64encoded = fromUint8Array(new Uint8Array(body));
    return `data:image/png;base64,${b64encoded}`;
  } catch (error) {
    return;
  }
}

/** 基金持仓（股票/债券）统一从移动端接口获取，网页版持仓表格已下线 */
async function GetFundPositionsFromEastMoney(code: string) {
  const { body } = await request<any>('https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition', {
    searchParams: {
      FCODE: code,
      deviceid: FUND_DEVICE_ID,
      plat: 'Iphone',
      product: 'EFund',
      version: '6.2.8',
    },
    headers: FUND_MOBILE_HEADERS,
    responseType: 'json',
  });
  const datas = body?.Datas || {};
  return {
    stocks: Array.isArray(datas.fundStocks) ? datas.fundStocks : [],
    bonds: Array.isArray(datas.fundboods) ? datas.fundboods : [],
    quarter: body?.Expansion || '',
  };
}

// 从天天基金获取股票持仓
export async function GetStockWareHouseFromEastmoney(code: string, stockCodes: string[]) {
  try {
    const { stocks } = await GetFundPositionsFromEastMoney(code);
    const positions = stocks.filter((item: any) => item.GPDM);
    // 优先使用持仓接口返回的股票代码，接口无数据时退回基金详情里的持仓代码
    const secids = positions.length
      ? positions.map((item: any) => `${item.NEWTEXCH ?? item.TEXCH ?? 0}.${item.GPDM}`).join(',')
      : (stockCodes || []).join(',');
    if (!secids) {
      return [];
    }
    const warehouseMap = new Map(positions.map((item: any) => [String(item.GPDM), String(item.JZBL ?? '')]));

    const {
      body: { data },
    } = await request<any>('https://push2.eastmoney.com/api/qt/ulist.np/get', {
      searchParams: {
        fields: 'f2,f3,f12,f13,f14',
        fltt: 2,
        secids,
      },
      responseType: 'json',
    });
    const diff: any[] = data?.diff || [];

    const result: Fund.WareHouse[] = diff.map((item) => {
      return {
        zxz: item.f2,
        name: item.f14,
        market: item.f13,
        code: item.f12,
        zdf: item.f3,
        ccb: warehouseMap.get(String(item.f12)) ?? '',
      };
    });
    return result;
  } catch (error) {
    return [];
  }
}

// 从天天基金获取债券持仓
export async function GetSecuritiesWareHouseFromEastmoney(code: string, securitiesCodes: string) {
  try {
    const { bonds } = await GetFundPositionsFromEastMoney(code);
    if (!bonds.length) {
      return [];
    }
    return bonds
      .filter((item: any) => item.ZQDM)
      .map((item: any) => ({
        zxz: '--',
        name: String(item.ZQMC || item.ZQDM),
        market: 0,
        code: String(item.ZQDM),
        zdf: 0,
        ccb: String(item.ZJZBL ?? ''),
      })) as Fund.WareHouse[];
  } catch (error) {
    return [];
  }
}

// 从天天基金获取基金详情
export async function GetFundDetailFromEastmoney(code: string) {
  try {
    const { body } = await request(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
      responseType: 'text',
    });
    const response: Fund.PingzhongData = Utils.Parsepingzhongdata(body);
    return response;
  } catch (error) {
    return;
  }
}

// 从天天基金获取近期表现
export async function GetFundPerformanceFromEastmoney(
  code: string,
  type: string // 'm' | 'q' | 'hy' | 'y' | 'try' | 'se'
) {
  try {
    const {
      body: { Data },
    } = await request<any>(`https://api.fund.eastmoney.com/pinzhong/LJSYLZS`, {
      searchParams: {
        fundCode: code,
        indexcode: '000300',
        type,
      },
      headers: {
        Referer: 'https://fund.eastmoney.com/',
      },

      responseType: 'json',
    });

    const result: any[] = Data;
    return result;
  } catch (error) {
    return [];
  }
}

// 从天天基金获取所有基金信息
export async function GetRemoteFundsFromEastmoney() {
  try {
    const { body } = await request('https://fund.eastmoney.com/js/fundcode_search.js', { responseType: 'text' });
    return Utils.ParseRemoteFunds(body);
  } catch (error) {
    return [];
  }
}

// 从天天基金查询最新净值信息
export async function GetFixFromEastMoney(code: string) {
  try {
    const { body: html } = await request(`https://fund.eastmoney.com/${code}.html`, { responseType: 'text' });
    const $ = cheerio.load(html);
    const isCurrency = $('.sp01').find('a').text().includes('每万份收益');
    const fixZzl =
      $('.fix_zzl')
        .text()
        ?.replace(/[^0-9/./-]/g, '') || '0';
    const fixDate = $('.fix_date')
      .text()
      ?.replace(/[^0-9/-]/g, '');
    const fixDwjz =
      $('.fix_dwjz')
        .text()
        ?.replace(/[^0-9/.]/g, '') || '0';
    const fixName = $('.fix_fname').text();

    const result: Fund.FixData = {
      code,
      fixName,
      fixDwjz: isCurrency ? '1.0000' : fixDwjz,
      fixZzl: isCurrency ? (Number(fixDwjz) / 10000).toFixed(2) : fixZzl,
      fixDate,
      isCurrency,
    };
    return result;
  } catch (error) {
    return;
  }
}

// 从天天基金查询基金经理详情信息
export async function GetFundManagerDetailFromEastMoney(code: string) {
  try {
    const { body: html } = await request(`https://fund.eastmoney.com/manager/${code}.html`, { responseType: 'text' });
    const $ = cheerio.load(html);
    const description = $('meta[name="description"]').attr('content') || '';
    const table = $('.content_in').find('.ftrs')[0];

    const manageHistoryFunds: Fund.Manager.ManageHistoryFund[] = $(table)
      .find('tbody tr')
      .toArray()
      .map((tr) => {
        // 0: "002560"
        // 1: "诺安和鑫灵活配置混合"
        // 2: "估值图基金吧档案"
        // 3: "混合型"
        // 4: "82.17"
        // 5: "2019-03-14 ~ 至今"
        // 6: "2年又6天"
        // 7: "80.80%"
        const [code, name, unknow1, type, unknow2, date, days, rzhb] = $(tr)
          .find('td')
          .toArray()
          .map((td) => $(td).text());
        return {
          code,
          name,
          type,
          date,
          days,
          rzhb,
        };
      });

    return {
      manageHistoryFunds,
      description,
    };
  } catch (error) {
    return {
      manageHistoryFunds: [],
      description: '',
    };
  }
}

// 查询天天基金QDII基金信息
export async function GetQDIIFundFromEastMoney(code: string) {
  try {
    const { fixDwjz, fixName, fixDate, fixZzl } = (await GetFixFromEastMoney(code))!;
    return {
      name: fixName,
      dwjz: fixDwjz,
      fundcode: code,
      gztime: `${new Date().getFullYear()}-暂无估值`,
      jzrq: `${new Date().getFullYear()}-${fixDate}`,
      gsz: fixDwjz,
      gszzl: '',
    };
  } catch (error) {
    return;
  }
}

// 时分查询QDII,查询ETF最新估值
export async function GetEtfFundHourFromEastMoney(code: string) {
  try {
    const { body } = await request<{
      rc: 0;
      rt: 4;
      svr: 182482208;
      lt: 1;
      full: 1;
      dlmkts: '';
      data: {
        f43: 866 | '-';
        f44: 870;
        f45: 863;
        f46: 868;
        f47: 3355871;
        f48: 290470752.0;
        f49: 1667897;
        f50: 61;
        f51: 966;
        f52: 790;
        f57: '513100';
        f58: '纳指ETF';
        f59: 3;
        f60: 878;
        f71: 866;
        f86: 1652083195;
        f107: 1;
        f108: '-';
        f152: 2;
        f161: 1687975;
        f167: '-';
        f168: 731;
        f169: -12;
        f170: -137 | '-';
        f171: 80;
        f191: 4011;
        f192: 92410;
        f292: 5;
        f452: -10;
        f31: 871;
        f32: 2373;
        f33: 870;
        f34: 12014;
        f35: 869;
        f36: 7106;
        f37: 868;
        f38: 16336;
        f39: 867;
        f40: 31152;
        f19: 866;
        f20: 4209;
        f17: 865;
        f18: 84511;
        f15: 864;
        f16: 18576;
        f13: 863;
        f14: 33862;
        f11: 862;
        f12: 20233;
      };
    }>('https://push2.eastmoney.com/api/qt/stock/get', {
      searchParams: {
        invt: 2,
        fltt: 1,
        fields:
          'f58,f107,f57,f43,f59,f169,f170,f152,f46,f60,f44,f45,f47,f48,f19,f17,f531,f15,f13,f11,f20,f18,f16,f14,f12,f39,f37,f35,f33,f31,f40,f38,f36,f34,f32,f211,f212,f213,f214,f215,f210,f209,f208,f207,f206,f161,f49,f171,f50,f86,f168,f108,f167,f71,f292,f51,f52,f191,f192,f452',
        secid: `${code.startsWith('51') ? 1 : 0}.${code}`,
        wbp2u: '|0|0|0|web',
        _: Date.now(),
      },
      responseType: 'json',
    });

    if (body.data.f58.toLocaleLowerCase().includes('etf')) {
      return {
        name: body.data.f58,
        dwjz: NP.divide(Number(body.data.f60), 1000).toFixed(4),
        fundcode: code,
        gztime: dayjs(body.data.f86 * 1000).format('YYYY-MM-DD HH:mm'),
        jzrq: `${new Date().getFullYear()}-昨收`,
        gsz: NP.divide(Number(body.data.f43 === '-' ? body.data.f60 : body.data.f43), 1000).toString(), // 未开盘用昨收做估值
        gszzl: NP.divide(Number(body.data.f170 === '-' ? 0 : body.data.f170), 100).toFixed(2), // 未开盘，增长率为0
      };
    } else {
      throw Error('不是ETF基金');
    }
  } catch (error) {
    return await GetQDIIFundFromEastMoney(code);
  }
}

// 查询蚂蚁基金QDII基金信息
export async function GetQDIIFundFromFund123(code: string) {
  try {
    const { body: html } = await request(`https://www.fund123.cn/matiaria`, {
      responseType: 'text',
      searchParams: {
        fundCode: code,
      },
    });
    const $ = cheerio.load(html);
    const script = $('script').eq(2).html();
    const fixscript = script?.replace(/window\.context/g, 'const o');
    const context = eval(`(() => {
      ${fixscript}
      return o;
    })()`);
    const {
      csrf,
      materialInfo: {
        productId,
        fundCode,
        fundBrief: { fundNameAbbr },
        titleInfo: { netValue, netValueDate, dayOfGrowth },
      },
    }: {
      success: true;
      message: '请求成功';
      materialInfo: {
        productId: '20170808000230030000000000013513';
        fundCode: '002258';
        fundType: '混合型';
        titleInfo: {
          fundLimit: '0--';
          netValue: string; // '3.6580';
          netValueDate: '09-13';
          profitSevenDays: '--';
          profitTenThousand: '--';
          dayOfGrowth: '2.46';
          lastWeek: '5.88';
          riskEvaluation: '中高风险';
          establishmentDate: '2017-09-21';
          assetSize: '1.04亿';
          fundManagerName: '韩创';
        };
        fundBrief: {
          fundNameAbbr: '大成国企改革灵活配置混合';
          fundName: '大成国企改革灵活配置混合型证券投资基金';
          fundCode: '002258';
          establishmentDate: '2017-\n          09-\n          21';
          shareSize: '41784787.66';
          assetSize: '104651741.15';
          fundManagerName: '韩创';
          saleStatus: '正常申购';
          fundCompanyName: '大成基金管理有限公司';
          trusteeName: '中国银行股份有限公司';
          manageRate: '1.5%';
          trusteeRate: '0.25%';
          purchaseMinMount: '10.00';
          redeemMinMount: '1';
          purchaseRatio: '--';
          redeemRatio: '--';
          generalInfo: {
            fundName: '大成国企改革灵活配置混合型证券投资基金';
            establishmentDate: '2017-\n            09-\n            21';
            fundCode: '002258';
            assetSize: '104651741.15';
            fundCompanyName: '--';
            trusteeName: '中国银行股份有限公司';
            fundManagerBackground: '    韩创，中国国籍，金融学硕士，9年证券从业年限，具有基金从业资格。2012年6月至2015年6月曾任招商证券研究部研究员。2015年6月加入大成基金管理有限公司，历任研究部研究员、基金经理助理。2019年1月10日至2020年2月3日，担任大成消费主题混合型证券投资基金的基金经理。2019年1月10日起，担任大成新锐产业混合型证券投资基金的基金经理。2020年1月2日起，担任大成睿景灵活配置混合型证券投资基金的基金经理。2021年2月9日起，担任大成产业趋势混合型证券投资基金的基金经理。自2021年1月13日起，担任大成国企改革灵活配置混合型证券投资基金的基金经理。自2021年6月30日起，担任大成核心趋势混合型证券投资基金的基金经理。';
            fundManagerInfoList: [
              {
                key: '1';
                fundName: '大成新锐产业混合型证券投资基金';
                officeDate: '2019-01-10  至今';
                earnings: '3.979472';
              },
              {
                key: '2';
                fundName: '大成睿景灵活配置混合型证券投资基金A类';
                officeDate: '2020-01-02  至今';
                earnings: '2.241387';
              },
              {
                key: '3';
                fundName: '大成睿景灵活配置混合型证券投资基金C类';
                officeDate: '2020-01-02  至今';
                earnings: '2.201024';
              },
              {
                key: '4';
                fundName: '大成国企改革灵活配置混合型证券投资基金';
                officeDate: '2021-01-13  至今';
                earnings: '0.794896';
              },
              {
                key: '5';
                fundName: '大成产业趋势混合型证券投资基金A类';
                officeDate: '2021-02-09  至今';
                earnings: '0.448205';
              },
              {
                key: '6';
                fundName: '大成产业趋势混合型证券投资基金C类';
                officeDate: '2021-02-09  至今';
                earnings: '0.441500';
              },
              {
                key: '7';
                fundName: '大成核心趋势混合型证券投资基金C类';
                officeDate: '2021-06-30  至今';
                earnings: '0.225799';
              },
              {
                key: '8';
                fundName: '大成核心趋势混合型证券投资基金A类';
                officeDate: '2021-06-30  至今';
                earnings: '0.226099';
              }
            ];
            investPhilosophy: '    本基金的投资目标是通过投资于国企改革相关的优质上市公司，在严格控制风险的前提下，力争获取超越业绩比较基准的收益。';
            investStrategy: '    本基金通过对宏观经济环境、国家经济政策、股票市场风险、债券市场整体收益率曲线变化和资金供求关系等因素的分析，研判经济周期在美林投资时钟理论所处的阶段，综合评价各类资产的市场趋势、预期风险收益水平和配置时机。\r\n    本基金认为当前受益于国企改革的上市公司股票涉及多个行业，本基金将通过自下而上研究入库的方式，对各个行业中受益于国企改革主题的上市公司进行深入研究，并将这些股票组成本基金的核心股票库。\r\n    本基金将根据融资买入股票成本以及其他投资工具收益率综合评估是否采用融资方式买入股票，本基金在任何交易日日终持有的融资买入股票与直接买入股票市值之和，不得超过基金资产净值的95%。\r\n    本基金的债券投资采取稳健的投资管理方式，获得与风险相匹配的投资收益，以实现在一定程度上规避股票市场的系统性风险和保证基金资产的流动性。\r\n    中小企业私募债票面利率较高、信用风险较大、二级市场流动性较差。';
          };
        };
      };
      isLogin: false;
      csrf: 'GZiniT4s-CXuZczggNnZdY5lDoIb7ea5Jjho';
      isCloseEstimate: false;
      pageName: 'matiaria?fundCode=002258';
      uriBroker: {
        'favicon.ico.url': 'https://gw.alipayobjects.com/zos/rmsportal/mgPTSSvpLkKrsQwhoDzv.ico';
        'app.404.url': 'https://www.alipay.com/404.html';
        'zdrmdata.rest.url': 'http://zdrmdata-pool.gz00g.alipay.com';
        'app.errorpage.url': 'https://www.alipay.com/50x.html';
        'authcenter.url': 'https://auth.alipay.com';
        'app.goto.url': 'https://my.alipay.com/portal/i.htm';
        'bumng.url': 'https://bumng.alipay.com';
        'omeo.check.url': 'http://omeo-pool.gz00g.alipay.com';
        'omeo.get.url': 'https://omeo.alipay.com';
        'assets.url': 'https://gw.alipayobjects.com/a';
      };
    } = context;
    const now = dayjs();

    const result = {
      name: fundNameAbbr,
      fundcode: fundCode,
      gztime: `${new Date().getFullYear()}-暂无估值`,
      gsz: netValue,
      gszzl: '',
      jzrq: `${now.year()}-${netValueDate}`,
      dwjz: netValue,
    };

    return result;
  } catch (error) {
    return;
  }
}

// 查询同花顺QDII基金信息
export async function GetQDIIFundFromFund10jqka(code: string) {
  try {
    const { body } = await request<{
      data: [
        {
          code: '003834';
          enddate: '2021-09-30';
          type: 'nohbx';
          net: '3.8040';
          totalnet: '3.8040';
          ranges: '0.1330';
          rate: '3.62';
          net1: '3.6710';
          totalnet1: '3.6710';
          enddate1: '2021-09-29';
          mark: 'ths';
          updatetime: '211003024536';
          hqcode: 'JSH123';
          name: '华夏能源革新股票A';
          fundtype: string;
          clrq: '2017-06-07';
          manager: '郑泽鸿';
          orgname: '华夏基金管理有限公司';
          dqlcqx: '-1';
          dqrq: '';
          sgstat: '限制大额';
          shstat: '开放';
          money: '50.0000';
          sgoldfl: '1.5';
          sgfl: '0.15';
          rgStart: '2017-05-04';
          rgEnd: '2017-06-02';
          rcsgStart: '2017-07-07';
          rcshStart: '2017-07-07';
          ifnew: 0;
          rgfl: '0.15';
          rgflold: '1.5';
          buy: '1';
          dt: '1';
          zkl: '0.1';
          zdsg: '10';
          nowyear: '40.73';
          week: '-5.89';
          month: '-9.10';
          tmonth: '12.64';
          year: '130.27';
          hyear: '55.84';
          tyear: '346.48';
          mz: '1.0000';
          themeList: [
            {
              field_name: '特斯拉';
              field_type: '概念';
              id: 'd0a32faf345dc75d9c7c8f2479f9224a';
            },
            {
              field_name: '三星';
              field_type: '概念';
              id: '5131c72b5ed2ef94eaca2675bc7c6f0d';
            }
          ];
          thsqbfl: '';
          jjgm: '66.35';
          levelOfRiskCode: '706003';
          levelOfRisk: '中风险';
          ifzj: '1';
          ifgz: '1';
          iszcg: '1';
          iszcz: '0';
          isfof: '0';
          asset: '224.10';
          fundBanner: [];
          showType: '1';
          rgStartReal: '2017-05-04';
          rgStartRealTime: '2017-05-04 00:00:00';
          rgEndRealTime: '2017-06-02 15:00:00';
          fastcash: '1';
          dqlc: 0;
          lcqx: '--';
          maxStar: '5';
          nowtime: 1633309917000;
        }
      ];
      error: {
        id: 0;
        msg: 'is access';
      };
    }>(`https://fund.10jqka.com.cn/data/client/myfund/${code}`, {
      responseType: 'json',
    });
    const data = body.data.pop()!;

    return {
      name: data.name,
      fundcode: data.code,
      gztime: `${new Date().getFullYear()}-暂无估值`,
      gszzl: '',
      jzrq: data.enddate,
      dwjz: data.fundtype === '货币型' ? '1.0000' : data.net, // FIXME:货币基金无法获取单位净值 https://github.com/1zilc/fishing-funds/issues/672
      gsz: data.net,
    };
  } catch (error) {
    return;
  }
}

// 查询定投排行
export async function GetAutomaticPlanFromEastmoney(type: number) {
  try {
    const { body: html } = await request('https://fund.eastmoney.com/api/Dtshph.ashx', {
      responseType: 'text',
      searchParams: {
        c: 'dwjz',
        t: type,
        s: 'desc',
        issale: 1,
        page: 1,
        psize: 200,
        _: Date.now(),
      },
    });
    const $ = cheerio.load(html);
    const data = $('tbody tr')
      .toArray()
      .map((tr) => {
        const [checkbox, no, code, name, more, dwjz, jzrq, y1, y2, y3, y5, star] = $(tr)
          .find('td')
          .toArray()
          .map((td) => $(td).text());
        return {
          code,
          name,
          dwjz,
          jzrq,
          y1,
          y2,
          y3,
          y5,
          star,
        };
      });
    return data;
  } catch (error) {
    return [];
  }
}

// 查询基金排行
export async function GetRankDataFromEasemoney(type: string) {
  try {
    const now = new Date();
    const { body } = await request('https://fund.eastmoney.com/data/rankhandler.aspx', {
      responseType: 'text',
      headers: {
        Referer: 'https://fund.eastmoney.com/data/fundranking.html',
      },
      searchParams: {
        op: 'ph',
        dt: 'kf',
        ft: type,
        rs: '',
        gs: 0,
        sc: '1yzf',
        st: 'desc',
        qdii: '',
        tabSubtype: ',,,,,',
        pi: 1,
        pn: 200,
        dx: 1,
        sd: `${now.getFullYear() - 1}-${now.getMonth() + 1}-${now.getDate()}`,
        ed: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
      },
    });
    return eval(`(() => {
      ${body}
      return rankData.datas;
    })()`);
  } catch (error) {
    return [];
  }
}

// 查询基金评级排行
export async function GetFundRatingFromEasemoney() {
  try {
    const { body: html } = await request('https://fund.eastmoney.com/data/fundrating.html', { responseType: 'text' });
    const $ = cheerio.load(html);
    const script = $('#fundinfo').find('script').html();
    const fundinfos = eval(`(() => {
      ${script}
      return fundinfos;
    })()`);
    const result: Fund.RantingItem[] = fundinfos.split('_').map((item: string) => {
      // 270007|广发大盘成长混合|混合型-偏股|苗宇|30331916|广发|80000248|2|4|0|3|0|5|0|1|0|5|1|0.15%|1|1|002|211|GFDPCZHH|GFJJ|30331916
      const [code, name, type, manager, v1, jj, v2, totalFullStar, v3, v4, zsStar, v5, szStar, v6, v7, v8, jaStar] =
        item.split('|');
      const total = 0 + Number(szStar || 0) + Number(zsStar || 0) + Number(jaStar || 0);
      return { code, name, type, szStar, zsStar, jaStar, total };
    });
    result.sort((a, b) => b.total - a.total);
    return result;
  } catch (error) {
    return [];
  }
}

// 查询基金持仓行业占比
export async function GetIndustryRateFromEaseMoney(code: string) {
  try {
    // 与持仓数据同源，按重仓股所属行业（INDEXNAME）聚合展示
    const { stocks, quarter } = await GetFundPositionsFromEastMoney(code);
    return {
      stocks: stocks.filter((item: any) => item.INDEXNAME && item.INDEXNAME !== '--'),
      expansion: quarter,
    };
  } catch (error) {
    return {
      stocks: [],
      expansion: '',
    };
  }
}

// 查询今日排行
export async function GetTodayListFromEastmoney(type: number) {
  try {
    const { body } = await request<{
      Data: {
        typeStr: '1';
        sort: '3';
        sortType: 'desc';
        canbuy: '0';
        gzrq: '2021-11-18';
        gxrq: '2021-11-19';
        list: {
          bzdm: '502010';
          ListTexch: '1';
          FScaleType: '01';
          PLevel: 103.0;
          JJGSID: '80000229';
          IsExchg: '0';
          FType: '指数型-股票';
          Discount: 1.0;
          Rate: '0.10%';
          feature: '020,050,051,054';
          fundtype: '001';
          gxrq: '2021-11-19';
          jjlx3: null;
          IsListTrade: '1';
          jjlx2: null;
          shzt: null;
          sgzt: '开放申购';
          isbuy: '1';
          gzrq: '2021-11-18';
          gspc: '0.02%';
          gsz: '1.2869';
          gszzl: '1.95%';
          jzzzl: '1.93%';
          dwjz: '1.2623';
          gbdwjz: '1.2867';
          jjjcpy: 'YFDZZQZZQGSZSLOFA';
          jjjc: '易方达中证全指证券公司指数(LOF)A';
          jjlx: null;
          gszzlcolor: 'ui-table-up';
          jzzzlcolor: 'ui-table-up';
        }[];
      };
      ErrCode: 0;
      ErrMsg: null;
      TotalCount: 12631;
      Expansion: null;
      PageSize: 200;
      PageIndex: 1;
    }>('https://api.fund.eastmoney.com/FundGuZhi/GetFundGZList', {
      searchParams: {
        type,
        sort: 3,
        orderType: 'desc',
        canbuy: 0,
        pageIndex: 1,
        pageSize: 200,
        _: Date.now(),
      },
      headers: {
        Referer: 'https://fund.eastmoney.com/',
      },
      responseType: 'json',
    });

    const data = body.Data.list;
    return data;
  } catch (error) {
    return [];
  }
}

// 根据名称从天天基金获取基金信息
export async function GetFundInfoByNameFromEaseMoney(name: string) {
  // ?callback=jQuery18305749822041299978_1757244568639&m=1&key=%E8%AF%BA%E5%AE%89%E6%88%90%E9%95%BF&_=1757245522994
  try {
    const { body } = await request<{
      ErrCode: 0;
      ErrMsg: 'fromcache';
      Datas: [
        {
          _id: '025333';
          CODE: '025333';
          NAME: '诺安成长混合C';
          JP: 'NACZHHC';
          CATEGORY: 700;
          CATEGORYDESC: '基金';
          STOCKMARKET: null;
          BACKCODE: '025333';
          MatchCount: 1;
          FundBaseInfo: {
            _id: '025333';
            FCODE: '025333';
            FUNDTYPE: '002';
            ISBUY: '';
            JJGS: '诺安基金';
            JJGSBID: 40.0;
            JJGSID: '80049689';
            JJJL: '刘慧影';
            JJJLID: '30775155';
            MINSG: 1.0;
            OTHERNAME: '';
            RSFUNDTYPE: '002';
            SHORTNAME: '诺安成长混合C';
            FTYPE: '混合型-偏股';
            DWJZ: 1.591;
            FSRQ: '2025-09-05';
            NAVURL: 'http://fund.eastmoney.com/HH_jzzzl.html';
          };
          StockHolder: null;
          ZTJJInfo: [{ TTYPE: 'BK000054'; TTYPENAME: '半导体' }, { TTYPE: 'BK000239'; TTYPENAME: '第三代半导体' }];
          SEARCHWEIGHT: 0.0;
          NEWTEXCH: '';
        },
        {
          _id: '320007';
          CODE: '320007';
          NAME: '诺安成长混合A';
          JP: 'NACZHHA';
          CATEGORY: 700;
          CATEGORYDESC: '基金';
          STOCKMARKET: null;
          BACKCODE: '320007';
          MatchCount: 1;
          FundBaseInfo: {
            _id: '320007';
            DWJZ: 1.592;
            FCODE: '320007';
            FSRQ: '2025-09-05';
            FTYPE: '混合型-偏股';
            FUNDTYPE: '002';
            ISBUY: '1';
            JJGS: '诺安基金';
            JJGSBID: 40.0;
            JJGSID: '80049689';
            JJJL: '刘慧影';
            JJJLID: '30775155';
            MINSG: 10.0;
            OTHERNAME: '诺安成长股票,诺安成长混合';
            SHORTNAME: '诺安成长混合A';
            RSFUNDTYPE: '002';
            NAVURL: 'http://fund.eastmoney.com/HH_jzzzl.html';
          };
          StockHolder: null;
          ZTJJInfo: [{ TTYPE: 'BK000054'; TTYPENAME: '半导体' }, { TTYPE: 'BK000239'; TTYPENAME: '第三代半导体' }];
          SEARCHWEIGHT: 0.0;
          NEWTEXCH: '';
        }
      ];
    }>(`https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx`, {
      searchParams: {
        m: '1',
        key: name,
        _: Date.now(),
      },
      responseType: 'json',
    });

    return {
      name: body.Datas[0].NAME,
      code: body.Datas[0].CODE,
      dwjz: body.Datas[0].FundBaseInfo.DWJZ,
    };
  } catch {
    return;
  }
}
