import { Chain } from "@defillama/sdk/build/general";
import { request, gql } from "graphql-request";
import { getBlock } from "./getBlock";
import { BaseAdapter, ChainBlocks, FetchOptions } from "../adapters/types";
import { SimpleAdapter } from "../adapters/types";
import { DEFAULT_DATE_FIELD, getStartTimestamp } from "./getStartTimestamp";
import { Balances } from "@defillama/sdk";
import { wrapGraphError } from "./getUniSubgraph";


const getUniqStartOfTodayTimestamp = (date = new Date()) => {
  var date_utc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds()
  );
  var startOfDay = new Date(date_utc);
  var timestamp = startOfDay.getTime() / 1000;
  return Math.floor(timestamp / 86400) * 86400;
};

// To get ID for daily data https://docs.uniswap.org/protocol/V2/reference/API/entities
const getUniswapDateId = (date?: Date) => getUniqStartOfTodayTimestamp(date) / 86400;

const DEFAULT_TOTAL_VOLUME_FACTORY = "uniswapFactories";
const DEFAULT_TOTAL_VOLUME_FIELD = "totalVolumeUSD";

const DEFAULT_DAILY_VOLUME_FACTORY = "uniswapDayData";
const DEFAULT_DAILY_VOLUME_FIELD = "dailyVolumeUSD";
const DEFAULT_DAILY_DATE_FIELD = "date";

interface IGetChainVolumeParams {
  graphUrls: {
    [chains: string]: string
  },
  totalVolume: {
    factory: string,
    field: string
  },
  dailyVolume?: {
    factory: string,
    field: string,
    dateField?: string,
  },
  customDailyVolume?: string,
  hasDailyVolume?: boolean
  hasTotalVolume?: boolean
  getCustomBlock?: (timestamp: number) => Promise<number>
}
// HERE
function getChainVolume({
  graphUrls,
  totalVolume = {
    factory: DEFAULT_TOTAL_VOLUME_FACTORY,
    field: DEFAULT_TOTAL_VOLUME_FIELD,
  },
  dailyVolume = {
    factory: DEFAULT_DAILY_VOLUME_FACTORY,
    field: DEFAULT_DAILY_VOLUME_FIELD,
    dateField: DEFAULT_DAILY_DATE_FIELD
  },
  customDailyVolume = undefined,
  hasDailyVolume = true,
  hasTotalVolume = true,
  getCustomBlock = undefined,
}: IGetChainVolumeParams) {
  const totalVolumeQuery = gql`
  ${totalVolume.factory}(
    block: { number: $block }
    ) {
      ${totalVolume.field}
    }
    `;

  const dailyVolumeQuery =
    customDailyVolume ||
    gql`
    ${dailyVolume.factory} (id: $id) {
          ${dailyVolume.field}
      }`;

  const alternativeDaily = (timestamp: number) => gql`{
      ${dailyVolume.factory}s(where: {${dailyVolume.dateField}: ${timestamp}}) {
          ${dailyVolume.dateField}
          ${dailyVolume.field}
      }
  }`;

  const graphQueryTotalVolume = gql`${hasTotalVolume ? `query get_total_volume($block: Int) { ${totalVolumeQuery} }` : ""}`
  const graphQueryDailyVolume = gql`${hasDailyVolume ? `query get_daily_volume($id: Int) { ${dailyVolumeQuery} }` : ""}`;

  return (chain: Chain) => {
    return async (options: FetchOptions) => {
      const { endTimestamp, getEndBlock } = options;
      const customBlockFunc = getCustomBlock ? getCustomBlock : getEndBlock;
      const block = (await customBlockFunc(endTimestamp).catch((e: any) =>
        console.log(wrapGraphError(e).message),
      )) ?? undefined;
      const id = getUniswapDateId(new Date(endTimestamp * 1000));
      const graphResTotal = hasTotalVolume ? await request(graphUrls[chain], graphQueryTotalVolume, { block }).catch(e => {
        try {
          return JSON.parse(e.response.error).data
        } catch (error) {
          console.error(`Failed to get total volume on ${chain} ${graphUrls[chain]}: ${wrapGraphError(e).message}`)
        }
      }) : undefined;
      let graphResDaily = hasDailyVolume ? await request(graphUrls[chain], graphQueryDailyVolume, { id }).catch(e => {
        try {
          return JSON.parse(e.response.error).data
        } catch (error) {
          console.error(`Failed to get daily volume on ${chain} ${graphUrls[chain]}: ${wrapGraphError(e).message}`)
        }
      }) : undefined;
      let dailyVolumeValue = graphResDaily ? graphResDaily[dailyVolume.factory]?.[dailyVolume.field] : undefined
      if (hasDailyVolume && !dailyVolumeValue) {
        graphResDaily = await request(graphUrls[chain], alternativeDaily(getUniqStartOfTodayTimestamp(new Date(endTimestamp * 1000)))).catch(e => {
          try {
            return JSON.parse(e.response.error).data
          } catch (error) {
            console.error(`Failed to get daily volume via alternative query on ${graphUrls[chain]} ${chain}: ${wrapGraphError(e).message}`)
          }
        });
        const factory = dailyVolume.factory.toLowerCase().charAt(dailyVolume.factory.length - 1) === 's' ? dailyVolume.factory : `${dailyVolume.factory}s`
        dailyVolumeValue = graphResDaily ? graphResDaily[`${factory}`].reduce((p: any, c: any) => p + Number(c[`${dailyVolume.field}`]), 0) : undefined;
      }

      return {
        timestamp: endTimestamp,
        block,
        totalVolume: graphResTotal ? graphResTotal[totalVolume.factory]?.reduce((total: number, factory: any) => total + Number(factory[totalVolume.field]), 0) : undefined,
        dailyVolume: dailyVolumeValue,
      };
    };
  };
}

function getChainVolumeWithGasToken({
  graphUrls,
  totalVolume = {
    factory: DEFAULT_TOTAL_VOLUME_FACTORY,
    field: 'totalVolumeETH',
  },
  dailyVolume = {
    factory: DEFAULT_DAILY_VOLUME_FACTORY,
    field: 'dailyVolumeETH',
    dateField: DEFAULT_DAILY_DATE_FIELD
  },
  customDailyVolume = undefined,
  hasDailyVolume = true,
  hasTotalVolume = true,
  getCustomBlock = undefined,
  priceToken,
}: IGetChainVolumeParams & {priceToken:string}) {
  const basic = getChainVolume({graphUrls, totalVolume, dailyVolume, customDailyVolume, hasDailyVolume, hasTotalVolume, getCustomBlock})
  return (chain: Chain) => {
    return async (options: FetchOptions) => {
      const {
        block,
        totalVolume,
        dailyVolume,
      } = await basic(chain)(options);

      const timestamp = options.endTimestamp
      const balances = new Balances({ chain, timestamp })
      balances.add(priceToken, Number(dailyVolume).toFixed(0), { skipChain: true })

      return {
        timestamp,
        block,
        dailyVolume: await balances.getUSDString()
      }
    };
  };
}

function univ2Adapter(endpoints: {
  [chain: string]: string
}, {
  factoriesName = DEFAULT_TOTAL_VOLUME_FACTORY,
  dayData = DEFAULT_DAILY_VOLUME_FACTORY,
  totalVolume = DEFAULT_TOTAL_VOLUME_FIELD,
  dailyVolume = DEFAULT_DAILY_VOLUME_FIELD,
  dailyVolumeTimestampField = DEFAULT_DATE_FIELD,
  hasTotalVolume = true,
  gasToken = null as string|null
}) {
  const graphs = (gasToken === null ? getChainVolume : getChainVolumeWithGasToken as typeof getChainVolume)({
    graphUrls: endpoints,
    hasTotalVolume,
    totalVolume: {
      factory: factoriesName,
      field: totalVolume
    },
    dailyVolume: {
      factory: dayData,
      field: dailyVolume,
      dateField: dailyVolumeTimestampField
    },
    priceToken: gasToken
  } as any);

  const adapter: SimpleAdapter = {
    adapter: Object.keys(endpoints).reduce((acc, chain) => {
      return {
        ...acc,
        [chain]: {
          fetch: graphs(chain as Chain),
          start: getStartTimestamp({
            endpoints: endpoints,
            chain,
            volumeField: dailyVolume,
            dailyDataField: dayData + "s",
            dateField: dailyVolumeTimestampField
          }),
        }
      }
    }, {} as BaseAdapter),
    version: 2
  };

  return adapter;
}

export {
  getUniqStartOfTodayTimestamp,
  getChainVolume,
  getChainVolumeWithGasToken,
  univ2Adapter,
  DEFAULT_TOTAL_VOLUME_FACTORY,
  DEFAULT_TOTAL_VOLUME_FIELD,
  DEFAULT_DAILY_VOLUME_FACTORY,
  DEFAULT_DAILY_VOLUME_FIELD,
};
