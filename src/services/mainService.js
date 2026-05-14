const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const DEFAULT_MOCK_START_DATE = '2020-02-19';
const EODHD_BULK_LAST_DAY_URL = 'https://eodhd.com/api/eod-bulk-last-day/US';
const EODHD_EOD_URL = 'https://eodhd.com/api/eod';
const EODHD_FUNDAMENTALS_URL = 'https://eodhd.com/api/fundamentals';
const BENCHMARK_ETF_DIRECTORY = path.resolve(__dirname, '../../data/benchmark-etfs-data');
const OPENAI_SIMPLE_FIX_MODEL = 'gpt-5.4-mini';
const MOCK_PORTFOLIO_VALUES = [10000, 9840, 9400, 6880, 7340];
const MOCK_LOSS_CONTRIBUTIONS = [-0.14, -0.08, -0.046];
const sectorEtfMap = require('../../data/sector_etf_map.json');
const benchmarkEtfSeriesCache = new Map();
let openAiClient = null;

const analyzeUsersPortfolio = (exports.analyzeUsersPortfolio = async function analyzeUsersPortfolio({
	portfolio = [],
	crisis = {},
	nearestTradingDay,
	currentAdjustedClosePrices = {},
	historicalAdjustedCloseSeries = {},
	companySectorResolutions = {},
	sectorEtfFallbackSeries = {},
	etfSpyFallbackSeries = {}
} = {}) {
	const coverageWindow = getHistoricalCoverageWindow({
		startDate: nearestTradingDay,
		endDate: crisis?.endDate
	});
	const holdingResolutionEntries = buildHoldingResolutionEntries({
		portfolio,
		currentAdjustedClosePrices,
		historicalAdjustedCloseSeries,
		sectorEtfFallbackSeries,
		etfSpyFallbackSeries,
		coverageWindow
	});
	const omittedHoldings = buildOmittedHoldings(holdingResolutionEntries);
	const resolvedPortfolio = getResolvedPortfolio(holdingResolutionEntries);
	const resolvedHistoricalAdjustedCloseSeries = pickHistoricalSeriesBySource({
		holdingResolutionEntries,
		historicalAdjustedCloseSeries
	});
	const resolvedSectorEtfFallbackSeries = pickFallbackSeriesBySymbols({
		holdingResolutionEntries,
		fallbackSeries: sectorEtfFallbackSeries
	});
	const resolvedEtfSpyFallbackSeries = pickFallbackSeriesBySymbols({
		holdingResolutionEntries,
		fallbackSeries: etfSpyFallbackSeries
	});
	const holdingSeries = buildHoldingDailyValueSeries({
		holdingResolutionEntries,
		currentAdjustedClosePrices,
		historicalAdjustedCloseSeries: resolvedHistoricalAdjustedCloseSeries,
		sectorEtfFallbackSeries: resolvedSectorEtfFallbackSeries,
		etfSpyFallbackSeries: resolvedEtfSpyFallbackSeries
	});
	const series = aggregateHoldingSeries(holdingSeries);
	const summary = buildMockSummary(series, omittedHoldings.length);
	const fallbackUsage = buildFallbackUsage({
		sectorEtfFallbackSeries: resolvedSectorEtfFallbackSeries,
		etfSpyFallbackSeries: resolvedEtfSpyFallbackSeries
	});
	const warnings = buildWarnings({ fallbackUsage, omittedHoldings });
	const largestRiskContributors = buildLargestRiskContributors(
		holdingSeries,
		summary.startValue
	);

	return {
		ok: true,
		summary,
		series,
		warnings,
		analysisSummary: {
			crisisId: typeof crisis.id === 'string' ? crisis.id : 'mock-crisis',
			crisisLabel:
				typeof crisis.label === 'string' ? crisis.label : 'Mock Crisis Scenario',
			portfolioStartValue: summary.startValue,
			portfolioEndValue: summary.endValue,
			totalReturn: summary.totalReturn,
			maxDrawdown: summary.maxDrawdown,
			maxDrawdownDollars: summary.maxDrawdownDollars,
			largestRiskContributors,
			fallbackUsage,
			omittedHoldings
		}
	};
});

const getAiSimpleFix = (exports.getAiSimpleFix = async function getAiSimpleFix({ portfolio = [], crisis = {}, analysisSummary = {} } = {}) {
	const apiKey = process.env.OPENAI_API_KEY;

	if (!apiKey) {
		throw new Error('OPENAI_API_KEY is not configured.');
	}

	try {
		const response = await getOpenAiClient(apiKey).responses.create({
			model: OPENAI_SIMPLE_FIX_MODEL,
			instructions: buildAiSimpleFixInstructions(),
			input: buildAiSimpleFixInput({ portfolio, crisis, analysisSummary }),
			max_output_tokens: 80
		});

		const simpleFix = normalizeSimpleFixText(getOpenAiResponseText(response));

		if (!simpleFix) {
			throw new Error('OpenAI returned an empty simple fix.');
		}

		return {
			ok: true,
			simpleFix
		};
	} catch (error) {
		throw new Error(`OpenAI simple fix request failed: ${error.message}`);
	}
});

function getOpenAiClient(apiKey) {
	if (!openAiClient) {
		openAiClient = new OpenAI({ apiKey });
	}

	return openAiClient;
}

function buildAiSimpleFixInstructions() {
	return [
		'You write exactly one short sentence of portfolio advice for a retail investor.',
		'Return plain text only.',
		'Give one concrete action only, not a list.',
		'Keep it under 30 words.',
		'Start with an action verb when possible.',
		'Prefer a specific percentage change such as 10%, 15%, or 20% when the context supports it.',
		'Ground the advice in the supplied portfolio, crisis, and simulation summary.',
		'If the simulation summary is missing, still give the best single fix from the portfolio and crisis details.',
		'Prefer simple recommendations like moving part of the portfolio into bonds or cash, trimming a concentrated tech position, or shifting toward defensive assets.',
		'Do not use bullets, disclaimers, caveats, or mention needing more data.',
		'Do not invent exact performance improvements unless that number is explicitly provided.'
	].join(' ');
}

function buildAiSimpleFixInput({ portfolio, crisis, analysisSummary }) {
	return [
		'Target style example: Move 20% of your portfolio into safer assets like government bonds to reduce how hard this crash hits you.',
		'',
		'Portfolio context:',
		formatPortfolioForAi(portfolio),
		'',
		'Crisis context:',
		formatCrisisForAi(crisis),
		'',
		'Simulation context:',
		formatAnalysisSummaryForAi(analysisSummary),
		'',
		'Write the single best straightforward fix for this setup.'
	].join('\n');
}

function formatPortfolioForAi(portfolio) {
	if (!Array.isArray(portfolio) || portfolio.length === 0) {
		return 'No portfolio holdings were provided.';
	}

	return portfolio
		.slice(0, 8)
		.map((holding) => {
			const symbol = normalizeSymbol(holding?.symbol) || 'UNKNOWN';
			const quantity = normalizeQuantity(holding?.quantity);
			const type = isStockHolding(holding)
				? 'stock'
				: isEtfHolding(holding)
					? 'etf'
					: 'unknown';

			return `${symbol}: ${quantity === null ? 'unknown quantity' : quantity} ${type}`;
		})
		.join('\n');
}

function formatCrisisForAi(crisis) {
	if (!crisis || typeof crisis !== 'object') {
		return 'No crisis details were provided.';
	}

	const crisisLines = [];

	if (typeof crisis.label === 'string' && crisis.label.trim()) {
		crisisLines.push(`Label: ${crisis.label.trim()}`);
	}

	if (typeof crisis.description === 'string' && crisis.description.trim()) {
		crisisLines.push(`Description: ${crisis.description.trim()}`);
	}

	if (typeof crisis.window === 'string' && crisis.window.trim()) {
		crisisLines.push(`Window: ${crisis.window.trim()}`);
	}

	const sectorShockSummary = formatSectorShocksForAi(crisis.sectorShocks);

	if (sectorShockSummary) {
		crisisLines.push(sectorShockSummary);
	}

	return crisisLines.length > 0 ? crisisLines.join('\n') : 'No crisis details were provided.';
}

function formatSectorShocksForAi(sectorShocks) {
	if (!sectorShocks || typeof sectorShocks !== 'object') {
		return '';
	}

	const shockEntries = Object.entries(sectorShocks).filter(
		([sectorName, shockValue]) => typeof sectorName === 'string' && typeof shockValue === 'number'
	);

	if (shockEntries.length === 0) {
		return '';
	}

	const worstShocks = [...shockEntries]
		.sort((leftEntry, rightEntry) => leftEntry[1] - rightEntry[1])
		.slice(0, 3)
		.map(([sectorName, shockValue]) => `${formatSectorNameForAi(sectorName)} ${formatPercentForAi(shockValue)}`);

	const resilientShocks = [...shockEntries]
		.filter(([, shockValue]) => shockValue > -0.15)
		.sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1])
		.slice(0, 2)
		.map(([sectorName, shockValue]) => `${formatSectorNameForAi(sectorName)} ${formatPercentForAi(shockValue)}`);

	const shockLines = [];

	if (worstShocks.length > 0) {
		shockLines.push(`Worst shocks: ${worstShocks.join(', ')}`);
	}

	if (resilientShocks.length > 0) {
		shockLines.push(`Most resilient areas: ${resilientShocks.join(', ')}`);
	}

	return shockLines.join('\n');
}

function formatAnalysisSummaryForAi(analysisSummary) {
	if (!analysisSummary || typeof analysisSummary !== 'object' || Array.isArray(analysisSummary)) {
		return 'No simulation summary was provided.';
	}

	const summaryLines = [];

	if (typeof analysisSummary.crisisLabel === 'string' && analysisSummary.crisisLabel.trim()) {
		summaryLines.push(`Scenario: ${analysisSummary.crisisLabel.trim()}`);
	}

	if (typeof analysisSummary.portfolioStartValue === 'number') {
		summaryLines.push(`Start value: ${formatCurrencyForAi(analysisSummary.portfolioStartValue)}`);
	}

	if (typeof analysisSummary.portfolioEndValue === 'number') {
		summaryLines.push(`End value: ${formatCurrencyForAi(analysisSummary.portfolioEndValue)}`);
	}

	if (typeof analysisSummary.totalReturn === 'number') {
		summaryLines.push(`Total return: ${formatPercentForAi(analysisSummary.totalReturn)}`);
	}

	if (typeof analysisSummary.maxDrawdown === 'number') {
		summaryLines.push(`Max drawdown: ${formatPercentForAi(analysisSummary.maxDrawdown)}`);
	}

	if (typeof analysisSummary.maxDrawdownDollars === 'number') {
		summaryLines.push(`Max drawdown dollars: ${formatCurrencyForAi(analysisSummary.maxDrawdownDollars)}`);
	}

	const largestRiskContributors = Array.isArray(analysisSummary.largestRiskContributors)
		? analysisSummary.largestRiskContributors
				.map((entry) => normalizeSymbol(entry?.symbol))
				.filter(Boolean)
		: [];

	if (largestRiskContributors.length > 0) {
		summaryLines.push(`Largest loss contributors: ${largestRiskContributors.join(', ')}`);
	}

	const fallbackUsage = Array.isArray(analysisSummary.fallbackUsage)
		? analysisSummary.fallbackUsage
				.map((entry) => normalizeSymbol(entry?.source) || normalizeSymbol(entry?.symbol))
				.filter(Boolean)
		: [];

	if (fallbackUsage.length > 0) {
		summaryLines.push(`Fallback data used: ${fallbackUsage.join(', ')}`);
	}

	const omittedHoldings = Array.isArray(analysisSummary.omittedHoldings)
		? analysisSummary.omittedHoldings
				.map((entry) => normalizeSymbol(entry?.symbol))
				.filter(Boolean)
		: [];

	if (omittedHoldings.length > 0) {
		summaryLines.push(`Omitted holdings: ${omittedHoldings.join(', ')}`);
	}

	return summaryLines.length > 0 ? summaryLines.join('\n') : 'No simulation summary was provided.';
}

function formatSectorNameForAi(sectorName) {
	return sectorName
		.split('_')
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
		.join(' ');
}

function formatPercentForAi(metricValue) {
	return `${Math.round(metricValue * 100)}%`;
}

function formatCurrencyForAi(currencyValue) {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: 0
	}).format(currencyValue);
}

function getOpenAiResponseText(response) {
	if (typeof response?.output_text === 'string' && response.output_text.trim()) {
		return response.output_text;
	}

	if (!Array.isArray(response?.output)) {
		return '';
	}

	return response.output
		.flatMap((outputEntry) => (Array.isArray(outputEntry?.content) ? outputEntry.content : []))
		.filter((contentEntry) => contentEntry?.type === 'output_text' && typeof contentEntry.text === 'string')
		.map((contentEntry) => contentEntry.text.trim())
		.filter(Boolean)
		.join(' ');
}

function normalizeSimpleFixText(responseText) {
	if (typeof responseText !== 'string') {
		return null;
	}

	const normalizedText = responseText.replace(/\s+/g, ' ').trim().replace(/^["']+|["']+$/g, '');

	if (!normalizedText) {
		return null;
	}

	const firstSentenceMatch = normalizedText.match(/[^.!?]+[.!?]?/);

	if (!firstSentenceMatch) {
		return null;
	}

	const firstSentence = firstSentenceMatch[0].trim();

	if (!firstSentence) {
		return null;
	}

	return /[.!?]$/.test(firstSentence) ? firstSentence : `${firstSentence}.`;
}

const fetchCurrentAdjustedClosePrices = (exports.fetchCurrentAdjustedClosePrices = async function fetchCurrentAdjustedClosePrices(portfolio = []) {
	const symbols = getUniquePortfolioSymbols(portfolio);

	if (symbols.length === 0) {
		return {};
	}

	const apiToken = process.env.EODHD_API_TOKEN;

	if (!apiToken) {
		throw new Error('EODHD_API_TOKEN is not configured.');
	}

	const requestUrl = new URL(EODHD_BULK_LAST_DAY_URL);
    
	requestUrl.search = new URLSearchParams({
		api_token: apiToken,
		symbols: symbols.join(','),
		fmt: 'json'
	}).toString();

	const response = await fetch(requestUrl);

	if (!response.ok) {
		throw new Error(`EODHD current price request failed with status ${response.status}.`);
	}

	const records = await response.json();

	if (!Array.isArray(records)) {
		throw new Error('EODHD current price response was not an array.');
	}

	return records.reduce((priceMap, record) => {
		if (
			record &&
			typeof record.code === 'string' &&
			typeof record.adjusted_close === 'number'
		) {
			priceMap[record.code.toUpperCase()] = {
				adjustedClose: record.adjusted_close,
				date: typeof record.date === 'string' ? record.date : null
			};
		}

		return priceMap;
	}, {});
});

const fetchHistoricalAdjustedCloseSeries = (exports.fetchHistoricalAdjustedCloseSeries = async function fetchHistoricalAdjustedCloseSeries({
	portfolio = [],
	startDate,
	endDate
} = {}) {
	const symbols = getUniquePortfolioSymbols(portfolio);

	if (symbols.length === 0) {
		return {};
	}

	const apiToken = process.env.EODHD_API_TOKEN;

	if (!apiToken) {
		throw new Error('EODHD_API_TOKEN is not configured.');
	}

	const fromDate = normalizeHistoricalStartDate(startDate);
	const toDate = getHistoricalWindowEndDate({ startDate: fromDate, endDate });
	const seriesEntries = await Promise.all(
		symbols.map(async (symbol) => [
			symbol,
			await fetchSymbolHistoricalAdjustedCloseSeries({
				symbol,
				fromDate,
				toDate,
				apiToken
			})
		])
	);

	const historicalSeriesBySymbol = Object.fromEntries(seriesEntries);

	return historicalSeriesBySymbol;
});

const fetchCompanySectorResolutions = (exports.fetchCompanySectorResolutions = async function fetchCompanySectorResolutions({
	portfolio = [],
	historicalAdjustedCloseSeries = {},
	startDate,
	endDate
} = {}) {
    // symbols where we don't have enough data to cover crisis
	const symbols = getSymbolsNeedingSectorLookup({
		portfolio,
		historicalAdjustedCloseSeries,
		startDate,
		endDate
	});

	if (symbols.length === 0) {
		return {};
	}

	const apiToken = process.env.EODHD_API_TOKEN;

	if (!apiToken) {
		throw new Error('EODHD_API_TOKEN is not configured.');
	}

	const sectorEntries = await Promise.all(
		symbols.map(async (symbol) => [
			symbol,
			await fetchSymbolSectorResolution({ symbol, apiToken })
		])
	);

	const sectorResolutionsBySymbol = Object.fromEntries(sectorEntries);

	return sectorResolutionsBySymbol;
});

const fetchSectorEtfFallbackSeries = (exports.fetchSectorEtfFallbackSeries = async function fetchSectorEtfFallbackSeries({
	companySectorResolutions = {},
	startDate,
	endDate
} = {}) {
	const fallbackEntries = Object.entries(companySectorResolutions)
		.map(([symbol, sectorResolution]) => [
			symbol,
			getSectorEtfFallbackWindow({
				fallbackSymbol: sectorResolution?.sectorEtf,
				startDate,
				endDate
			})
		])
		.filter(([, fallbackEntry]) => fallbackEntry !== null);

	return Object.fromEntries(fallbackEntries);
});

const fetchEtfSpyFallbackSeries = (exports.fetchEtfSpyFallbackSeries = async function fetchEtfSpyFallbackSeries({
	portfolio = [],
	historicalAdjustedCloseSeries = {},
	startDate,
	endDate
} = {}) {
	const symbols = getSymbolsNeedingEtfSpyFallback({
		portfolio,
		historicalAdjustedCloseSeries,
		startDate,
		endDate
	});

	if (symbols.length === 0) {
		return {};
	}

	const fallbackEntries = symbols
		.map((symbol) => [
			symbol,
			getSectorEtfFallbackWindow({
				fallbackSymbol: sectorEtfMap.Fallback,
				startDate,
				endDate
			})
		])
		.filter(([, fallbackEntry]) => fallbackEntry !== null);

	return Object.fromEntries(fallbackEntries);
});


const getNearestTradingDay = (exports.getNearestTradingDay = function getNearestTradingDay(startDate) {
	return formatDate(createTradingStartDate(startDate));
});

function buildMockPortfolioSeries({
	startDate,
	portfolioStartValue,
	historicalAdjustedCloseSeries,
	sectorEtfFallbackSeries,
	etfSpyFallbackSeries
}) {
	const tradingDates = getMockTradingDates({
		startDate,
		historicalAdjustedCloseSeries,
		sectorEtfFallbackSeries,
		etfSpyFallbackSeries,
		totalDays: MOCK_PORTFOLIO_VALUES.length
	});
	const initialValue = portfolioStartValue;
	const scaleFactor = initialValue / MOCK_PORTFOLIO_VALUES[0];
	let peakValue = initialValue;

	return tradingDates.map((date, index) => {
		const portfolioValue = roundCurrency(MOCK_PORTFOLIO_VALUES[index] * scaleFactor);
		const previousValue =
			index === 0 ? portfolioValue : roundCurrency(MOCK_PORTFOLIO_VALUES[index - 1] * scaleFactor);

		peakValue = Math.max(peakValue, portfolioValue);

		return {
			date,
			portfolioValue,
			dailyReturn:
				index === 0 ? 0 : roundMetric((portfolioValue - previousValue) / previousValue),
			cumulativeReturn: roundMetric((portfolioValue - initialValue) / initialValue),
			drawdown: roundMetric((portfolioValue - peakValue) / peakValue)
		};
	});
}

function buildMockSummary(mockSeries, omittedHoldingsCount) {
	if (!Array.isArray(mockSeries) || mockSeries.length === 0) {
		return {
			startValue: 0,
			endValue: 0,
			totalReturn: 0,
			maxDrawdown: 0,
			maxDrawdownDollars: 0,
			tradingDays: 0,
			omittedHoldingsCount
		};
	}

	const startValue = mockSeries[0].portfolioValue;
	const endValue = mockSeries[mockSeries.length - 1].portfolioValue;
	const drawdownMetrics = getMaxDrawdownMetrics(mockSeries);

	return {
		startValue,
		endValue,
		totalReturn: roundMetric((endValue - startValue) / startValue),
		maxDrawdown: drawdownMetrics.maxDrawdown,
		maxDrawdownDollars: drawdownMetrics.maxDrawdownDollars,
		tradingDays: mockSeries.length,
		omittedHoldingsCount
	};
}

function buildWarnings({ fallbackUsage, omittedHoldings }) {
	const warnings = [];

	for (const fallbackEntry of fallbackUsage) {
		warnings.push(
			`${fallbackEntry.symbol} used ${fallbackEntry.source} fallback for the full crisis window.`
		);
	}

	for (const omittedHolding of omittedHoldings) {
		warnings.push(`${omittedHolding.symbol} was omitted: ${omittedHolding.reason}`);
	}

	return warnings;
}

function buildHoldingDailyValueSeries({
	holdingResolutionEntries,
	currentAdjustedClosePrices,
	historicalAdjustedCloseSeries,
	sectorEtfFallbackSeries,
	etfSpyFallbackSeries
}) {
	return holdingResolutionEntries
		.filter((entry) => !entry.omittedReason)
		.map((entry) =>
			buildHoldingSeriesEntry({
				entry,
				currentAdjustedClosePrices,
				historicalAdjustedCloseSeries,
				sectorEtfFallbackSeries,
				etfSpyFallbackSeries
			})
		)
		.filter(Boolean);
}

function buildHoldingSeriesEntry({
	entry,
	currentAdjustedClosePrices,
	historicalAdjustedCloseSeries,
	sectorEtfFallbackSeries,
	etfSpyFallbackSeries
}) {
	const symbol = entry.symbol;
	const quantity = normalizeQuantity(entry.holding?.quantity);
	const currentAdjustedClose = currentAdjustedClosePrices[symbol]?.adjustedClose;
	const priceSeriesSource = getHoldingPriceSeriesSource({
		entry,
		historicalAdjustedCloseSeries,
		sectorEtfFallbackSeries,
		etfSpyFallbackSeries
	});

	if (
		quantity === null ||
		typeof currentAdjustedClose !== 'number' ||
		!Array.isArray(priceSeriesSource.series) ||
		priceSeriesSource.series.length === 0 ||
		typeof priceSeriesSource.series[0].adjustedClose !== 'number' ||
		priceSeriesSource.series[0].adjustedClose <= 0
	) {
		return null;
	}

	const startValue = roundCurrency(quantity * currentAdjustedClose);
	const initialAdjustedClose = priceSeriesSource.series[0].adjustedClose;
	const series = [];

	for (const point of priceSeriesSource.series) {
		const holdingValue = roundCurrency(startValue * (point.adjustedClose / initialAdjustedClose));
		const previousValue = series.length === 0 ? holdingValue : series[series.length - 1].holdingValue;

		series.push({
			date: point.date,
			holdingValue,
			dailyReturn:
				series.length === 0 || previousValue === 0
					? 0
					: roundMetric((holdingValue - previousValue) / previousValue),
			cumulativeReturn:
				startValue === 0 ? 0 : roundMetric((holdingValue - startValue) / startValue)
		});
	}

	return {
		symbol,
		source: priceSeriesSource.source,
		fallbackSymbol: priceSeriesSource.fallbackSymbol,
		startValue,
		series
	};
}

function getHoldingPriceSeriesSource({
	entry,
	historicalAdjustedCloseSeries,
	sectorEtfFallbackSeries,
	etfSpyFallbackSeries
}) {
	if (entry.resolution === 'historical') {
		return {
			source: 'historical',
			fallbackSymbol: null,
			series: historicalAdjustedCloseSeries[entry.symbol] || []
		};
	}

	if (isStockHolding(entry.holding)) {
		return {
			source: 'fallback',
			fallbackSymbol: sectorEtfFallbackSeries[entry.symbol]?.fallbackSymbol || null,
			series: sectorEtfFallbackSeries[entry.symbol]?.series || []
		};
	}

	return {
		source: 'fallback',
		fallbackSymbol: etfSpyFallbackSeries[entry.symbol]?.fallbackSymbol || null,
		series: etfSpyFallbackSeries[entry.symbol]?.series || []
	};
}

function aggregateHoldingSeries(holdingSeries) {
	if (!Array.isArray(holdingSeries) || holdingSeries.length === 0) {
		return [];
	}

	const totalsByDate = new Map();

	for (const holdingEntry of holdingSeries) {
		for (const point of holdingEntry.series) {
			totalsByDate.set(
				point.date,
				roundCurrency((totalsByDate.get(point.date) || 0) + point.holdingValue)
			);
		}
	}

	const orderedDates = [...totalsByDate.keys()].sort();
	const startValue = totalsByDate.get(orderedDates[0]) || 0;
	let peakValue = startValue;

	return orderedDates.map((date, index) => {
		const portfolioValue = totalsByDate.get(date) || 0;
		const previousValue =
			index === 0 ? portfolioValue : totalsByDate.get(orderedDates[index - 1]) || 0;

		peakValue = Math.max(peakValue, portfolioValue);

		return {
			date,
			portfolioValue: roundCurrency(portfolioValue),
			dailyReturn:
				index === 0 || previousValue === 0
					? 0
					: roundMetric((portfolioValue - previousValue) / previousValue),
			cumulativeReturn:
				startValue === 0 ? 0 : roundMetric((portfolioValue - startValue) / startValue),
			drawdown:
				peakValue === 0 ? 0 : roundMetric((portfolioValue - peakValue) / peakValue)
		};
	});
}

function buildFallbackUsage({ sectorEtfFallbackSeries, etfSpyFallbackSeries }) {
	return [
		...mapFallbackSeriesToUsage(sectorEtfFallbackSeries),
		...mapFallbackSeriesToUsage(etfSpyFallbackSeries)
	];
}

function mapFallbackSeriesToUsage(fallbackSeries) {
	return Object.entries(fallbackSeries).map(([symbol, fallbackEntry]) => ({
		symbol,
		used: true,
		source: fallbackEntry.fallbackSymbol
	}));
}

function buildLargestRiskContributors(holdingSeries, portfolioStartValue) {
	if (!Array.isArray(holdingSeries) || holdingSeries.length === 0 || portfolioStartValue <= 0) {
		return [];
	}

	return holdingSeries
		.map((holdingEntry) => {
			const lowestValue = Math.min(...holdingEntry.series.map((point) => point.holdingValue));

			return {
				symbol: holdingEntry.symbol,
				estimatedLossContribution: roundMetric(
					(lowestValue - holdingEntry.startValue) / portfolioStartValue
				),
				source: holdingEntry.source
			};
		})
		.sort((leftEntry, rightEntry) => leftEntry.estimatedLossContribution - rightEntry.estimatedLossContribution)
		.slice(0, 3);
}

function getDefaultMockHoldings() {
	return [
		{ symbol: 'TSLA', quantity: 2, type: 'stock' },
		{ symbol: 'AAPL', quantity: 5, type: 'stock' },
		{ symbol: 'DIA', quantity: 3, type: 'etf' }
	];
}

function isEtfHolding(holding) {
	if (!holding || typeof holding.type !== 'string') {
		return false;
	}

	return holding.type.toLowerCase() === 'etf';
}

function getUniquePortfolioSymbols(portfolio) {
	if (!Array.isArray(portfolio)) {
		return [];
	}

	const symbols = portfolio
		.map((holding) => normalizeSymbol(holding?.symbol))
		.filter(Boolean);

	return [...new Set(symbols)];
}

function buildHoldingResolutionEntries({
	portfolio,
	currentAdjustedClosePrices,
	historicalAdjustedCloseSeries,
	sectorEtfFallbackSeries,
	etfSpyFallbackSeries,
	coverageWindow
}) {
	if (!Array.isArray(portfolio)) {
		return [];
	}

	return portfolio.map((holding) => buildHoldingResolutionEntry({
		holding,
		currentAdjustedClosePrices,
		historicalAdjustedCloseSeries,
		sectorEtfFallbackSeries,
		etfSpyFallbackSeries,
		coverageWindow
	}));
}

function buildHoldingResolutionEntry({
	holding,
	currentAdjustedClosePrices,
	historicalAdjustedCloseSeries,
	sectorEtfFallbackSeries,
	etfSpyFallbackSeries,
	coverageWindow
}) {
	const symbol = normalizeSymbol(holding?.symbol);

	if (!symbol) {
		return {
			holding,
			symbol: null,
			omittedReason: 'The holding symbol was missing.'
		};
	}

	if (typeof currentAdjustedClosePrices[symbol]?.adjustedClose !== 'number') {
		return {
			holding,
			symbol,
			omittedReason: 'No current adjusted-close price was available.'
		};
	}

	if (
		!isHistoricalCoverageMissing({
			series: historicalAdjustedCloseSeries[symbol],
			coverageWindow
		})
	) {
		return {
			holding,
			symbol,
			resolution: 'historical'
		};
	}

	if (isStockHolding(holding) && hasFallbackSeries(sectorEtfFallbackSeries[symbol])) {
		return {
			holding,
			symbol,
			resolution: 'fallback'
		};
	}

	if (isEtfHolding(holding) && hasFallbackSeries(etfSpyFallbackSeries[symbol])) {
		return {
			holding,
			symbol,
			resolution: 'fallback'
		};
	}

	return {
		holding,
		symbol,
		omittedReason: getOmittedHoldingReason(holding)
	};
}

function buildOmittedHoldings(holdingResolutionEntries) {
	return holdingResolutionEntries
		.filter((entry) => typeof entry.omittedReason === 'string')
		.map((entry) => ({
			symbol: entry.symbol || entry.holding?.symbol || 'unknown',
			reason: entry.omittedReason
		}));
}

function getResolvedPortfolio(holdingResolutionEntries) {
	return holdingResolutionEntries
		.filter((entry) => !entry.omittedReason)
		.map((entry) => entry.holding);
}

function pickHistoricalSeriesBySource({ holdingResolutionEntries, historicalAdjustedCloseSeries }) {
	const historicalSymbols = new Set(
		holdingResolutionEntries
			.filter((entry) => entry.resolution === 'historical')
			.map((entry) => entry.symbol)
	);

	return Object.fromEntries(
		Object.entries(historicalAdjustedCloseSeries).filter(([symbol]) => historicalSymbols.has(symbol))
	);
}

function pickFallbackSeriesBySymbols({ holdingResolutionEntries, fallbackSeries }) {
	const resolvedSymbols = new Set(
		holdingResolutionEntries
			.filter((entry) => entry.resolution === 'fallback')
			.map((entry) => entry.symbol)
	);

	return Object.fromEntries(
		Object.entries(fallbackSeries).filter(([symbol]) => resolvedSymbols.has(symbol))
	);
}

function hasFallbackSeries(fallbackEntry) {
	return Array.isArray(fallbackEntry?.series) && fallbackEntry.series.length > 0;
}

function getOmittedHoldingReason(holding) {
	if (isStockHolding(holding)) {
		return 'No full-window historical or sector ETF fallback data was available.';
	}

	if (isEtfHolding(holding)) {
		return 'No full-window historical or SPY fallback data was available.';
	}

	return 'No usable historical or fallback data was available.';
}

function getSymbolsNeedingSectorLookup({
	portfolio,
	historicalAdjustedCloseSeries,
	startDate,
	endDate
}) {
	if (!Array.isArray(portfolio)) {
		return [];
	}

	const coverageWindow = getHistoricalCoverageWindow({ startDate, endDate });
	const symbols = portfolio
		.filter((holding) => isStockHolding(holding))
		.map((holding) => normalizeSymbol(holding.symbol))
		.filter((symbol) => symbol && isHistoricalCoverageMissing({
			series: historicalAdjustedCloseSeries[symbol],
			coverageWindow
		}));

	return [...new Set(symbols)];
}

function getSymbolsNeedingEtfSpyFallback({
	portfolio,
	historicalAdjustedCloseSeries,
	startDate,
	endDate
}) {
	if (!Array.isArray(portfolio)) {
		return [];
	}

	const coverageWindow = getHistoricalCoverageWindow({ startDate, endDate });
	const symbols = portfolio
		.filter((holding) => isEtfHolding(holding))
		.map((holding) => normalizeSymbol(holding.symbol))
		.filter(
			(symbol) =>
				symbol &&
				isHistoricalCoverageMissing({
					series: historicalAdjustedCloseSeries[symbol],
					coverageWindow
				})
		);

	return [...new Set(symbols)];
}

function getPortfolioStartValue(portfolio, currentAdjustedClosePrices) {
	if (!Array.isArray(portfolio)) {
		return MOCK_PORTFOLIO_VALUES[0];
	}

	const portfolioStartValue = portfolio.reduce((totalValue, holding) => {
		const symbol = normalizeSymbol(holding?.symbol);
		const quantity = normalizeQuantity(holding?.quantity);
		const adjustedClose = currentAdjustedClosePrices[symbol]?.adjustedClose;

		if (!symbol || quantity === null || typeof adjustedClose !== 'number') {
			return totalValue;
		}

		return totalValue + quantity * adjustedClose;
	}, 0);

	if (portfolioStartValue <= 0) {
		return MOCK_PORTFOLIO_VALUES[0];
	}

	return roundCurrency(portfolioStartValue);
}

function normalizeSymbol(symbol) {
	if (typeof symbol !== 'string') {
		return null;
	}

	const normalizedSymbol = symbol.trim().toUpperCase();

	return normalizedSymbol || null;
}

function normalizeQuantity(quantity) {
	if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
		return null;
	}

	return quantity;
}

function isStockHolding(holding) {
	if (!holding || typeof holding.type !== 'string') {
		return false;
	}

	return holding.type.toLowerCase() === 'stock';
}

function buildMockTradingDates(startDate, totalDays) {
	const tradingDates = [];
	const cursorDate = parseDate(startDate);

	while (tradingDates.length < totalDays) {
		if (isTradingDay(cursorDate)) {
			tradingDates.push(formatDate(cursorDate));
		}

		cursorDate.setUTCDate(cursorDate.getUTCDate() + 1);
	}

	return tradingDates;
}

function getMockTradingDates({
	startDate,
	historicalAdjustedCloseSeries,
	sectorEtfFallbackSeries,
	etfSpyFallbackSeries,
	totalDays
}) {
	const historicalDates = getHistoricalTradingDates(historicalAdjustedCloseSeries, totalDays);

	if (historicalDates.length > 0) {
		return historicalDates;
	}

	const fallbackDates = getSectorFallbackTradingDates(sectorEtfFallbackSeries, totalDays);

	if (fallbackDates.length > 0) {
		return fallbackDates;
	}

	const etfFallbackDates = getEtfFallbackTradingDates(etfSpyFallbackSeries, totalDays);

	if (etfFallbackDates.length > 0) {
		return etfFallbackDates;
	}

	return buildMockTradingDates(startDate, totalDays);
}

function getHistoricalTradingDates(historicalAdjustedCloseSeries, totalDays) {
	const firstAvailableSeries = Object.values(historicalAdjustedCloseSeries).find(
		(series) => Array.isArray(series) && series.length > 0
	);

	if (!firstAvailableSeries) {
		return [];
	}

	return firstAvailableSeries.slice(0, totalDays).map((entry) => entry.date);
}

function getSectorFallbackTradingDates(sectorEtfFallbackSeries, totalDays) {
	const firstAvailableFallback = Object.values(sectorEtfFallbackSeries).find(
		(fallbackEntry) => Array.isArray(fallbackEntry?.series) && fallbackEntry.series.length > 0
	);

	if (!firstAvailableFallback) {
		return [];
	}

	return firstAvailableFallback.series.slice(0, totalDays).map((entry) => entry.date);
}

function getEtfFallbackTradingDates(etfSpyFallbackSeries, totalDays) {
	const firstAvailableFallback = Object.values(etfSpyFallbackSeries).find(
		(fallbackEntry) => Array.isArray(fallbackEntry?.series) && fallbackEntry.series.length > 0
	);

	if (!firstAvailableFallback) {
		return [];
	}

	return firstAvailableFallback.series.slice(0, totalDays).map((entry) => entry.date);
}

function parseDate(startDate) {
	if (typeof startDate !== 'string') {
		return new Date(`${DEFAULT_MOCK_START_DATE}T00:00:00Z`);
	}

	const parsedDate = new Date(`${startDate}T00:00:00Z`);

	if (Number.isNaN(parsedDate.getTime())) {
		return new Date(`${DEFAULT_MOCK_START_DATE}T00:00:00Z`);
	}

	return parsedDate;
}

function normalizeHistoricalStartDate(startDate) {
	return typeof startDate === 'string' ? startDate : getNearestTradingDay(DEFAULT_MOCK_START_DATE);
}

function getHistoricalWindowEndDate({ startDate, endDate }) {
	const normalizedStartDate = normalizeHistoricalStartDate(startDate);

	if (typeof endDate !== 'string') {
		return normalizedStartDate;
	}

	const parsedStartDate = parseDate(normalizedStartDate);
	const parsedEndDate = parseDate(endDate);

	if (parsedEndDate.getTime() < parsedStartDate.getTime()) {
		return normalizedStartDate;
	}

	return formatDate(parsedEndDate);
}

async function fetchSymbolHistoricalAdjustedCloseSeries({ symbol, fromDate, toDate, apiToken }) {
	const requestUrl = new URL(`${EODHD_EOD_URL}/${symbol}.US`);
	requestUrl.search = new URLSearchParams({
		api_token: apiToken,
		fmt: 'json',
		from: fromDate,
		to: toDate
	}).toString();

	const response = await fetch(requestUrl);

	if (!response.ok) {
		throw new Error(
			`EODHD historical price request failed for ${symbol} with status ${response.status}.`
		);
	}

	const records = await response.json();

	if (!Array.isArray(records)) {
		throw new Error(`EODHD historical price response for ${symbol} was not an array.`);
	}

	return records
		.filter(
			(record) =>
				record &&
				typeof record.date === 'string' &&
				typeof record.adjusted_close === 'number'
		)
		.map((record) => ({
			date: record.date,
			adjustedClose: record.adjusted_close
		}));
}

function isHistoricalCoverageMissing({ series, coverageWindow }) {
	if (!Array.isArray(series)) {
		return true;
	}

	if (series.length === 0) {
		return true;
	}

	const seriesDates = new Set(series.map((entry) => entry.date));

	if (
		typeof coverageWindow?.firstExpectedDate === 'string' &&
		series[0]?.date !== coverageWindow.firstExpectedDate
	) {
		return true;
	}

	if (
		typeof coverageWindow?.lastExpectedDate === 'string' &&
		series[series.length - 1]?.date !== coverageWindow.lastExpectedDate
	) {
		return true;
	}

	if (!Array.isArray(coverageWindow?.referenceDates) || coverageWindow.referenceDates.length === 0) {
		return false;
	}

	return coverageWindow.referenceDates.some((date) => !seriesDates.has(date));
}

function getHistoricalCoverageWindow({ startDate, endDate }) {
	const fromDate = normalizeHistoricalStartDate(startDate);
	const toDate = getHistoricalWindowEndDate({ startDate: fromDate, endDate });
	const referenceDates = getReferenceTradingDates({ fromDate, toDate });

	if (referenceDates.length === 0) {
		return {
			fromDate,
			toDate,
			referenceDates: [],
			firstExpectedDate: fromDate,
			lastExpectedDate: null
		};
	}

	return {
		fromDate,
		toDate,
		referenceDates,
		firstExpectedDate: referenceDates[0],
		lastExpectedDate: referenceDates[referenceDates.length - 1]
	};
}

function getReferenceTradingDates({ fromDate, toDate }) {
	const fallbackSymbol = typeof sectorEtfMap.Fallback === 'string' ? sectorEtfMap.Fallback : null;
	const benchmarkSeries = fallbackSymbol ? loadBenchmarkEtfSeries(fallbackSymbol) : null;

	if (!Array.isArray(benchmarkSeries) || benchmarkSeries.length === 0) {
		return [];
	}

	return benchmarkSeries
		.filter((entry) => entry.date >= fromDate && entry.date <= toDate)
		.map((entry) => entry.date);
}

async function fetchSymbolSectorResolution({ symbol, apiToken }) {
	const requestUrl = new URL(`${EODHD_FUNDAMENTALS_URL}/${symbol}`);
	requestUrl.search = new URLSearchParams({
		api_token: apiToken,
		fmt: 'json',
		filter: 'General'
	}).toString();

	const response = await fetch(requestUrl);

	if (!response.ok) {
		throw new Error(
			`EODHD fundamentals request failed for ${symbol} with status ${response.status}.`
		);
	}

	const generalData = await response.json();

	if (!generalData || typeof generalData !== 'object' || Array.isArray(generalData)) {
		throw new Error(`EODHD fundamentals response for ${symbol} was not an object.`);
	}

	const rawSector = normalizeSectorText(generalData.Sector);
	const normalizedSector = normalizeSector(rawSector);

	return {
		rawSector,
		normalizedSector,
		sectorEtf: getSectorEtf(normalizedSector),
		industry: normalizeSectorText(generalData.Industry),
		type: normalizeSectorText(generalData.Type)
	};
}

function getSectorEtfFallbackWindow({ fallbackSymbol, startDate, endDate }) {
	if (typeof fallbackSymbol !== 'string' || !fallbackSymbol) {
		return null;
	}

	const coverageWindow = getHistoricalCoverageWindow({ startDate, endDate });
	const { fromDate, toDate } = coverageWindow;
	const benchmarkSeries = loadBenchmarkEtfSeries(fallbackSymbol);

	if (!Array.isArray(benchmarkSeries) || benchmarkSeries.length === 0) {
		return null;
	}

	const windowSeries = benchmarkSeries.filter(
		(entry) => entry.date >= fromDate && entry.date <= toDate
	);

	if (isHistoricalCoverageMissing({ series: windowSeries, coverageWindow })) {
		return null;
	}

	return {
		fallbackSymbol,
		series: windowSeries
	};
}

function loadBenchmarkEtfSeries(symbol) {
	if (benchmarkEtfSeriesCache.has(symbol)) {
		return benchmarkEtfSeriesCache.get(symbol);
	}

	const filePath = path.resolve(BENCHMARK_ETF_DIRECTORY, `${symbol}.json`);

	if (!fs.existsSync(filePath)) {
		benchmarkEtfSeriesCache.set(symbol, null);
		return null;
	}

	const fileContents = fs.readFileSync(filePath, 'utf8');
	const parsedSeries = JSON.parse(fileContents);

	if (!Array.isArray(parsedSeries)) {
		benchmarkEtfSeriesCache.set(symbol, null);
		return null;
	}

	const normalizedSeries = parsedSeries
		.filter(
			(entry) =>
				entry &&
				typeof entry.date === 'string' &&
				typeof entry.adjusted_close === 'number'
		)
		.map((entry) => ({
			date: entry.date,
			adjustedClose: entry.adjusted_close
		}));

	benchmarkEtfSeriesCache.set(symbol, normalizedSeries);

	return normalizedSeries;
}

function getSectorEtf(normalizedSector) {
	if (normalizedSector && sectorEtfMap[normalizedSector]) {
		return sectorEtfMap[normalizedSector];
	}

	return sectorEtfMap.Fallback || null;
}

function normalizeSector(rawSector) {
	if (!rawSector) {
		return null;
	}

	const normalizedSector = Object.keys(sectorEtfMap).find(
		(sectorName) =>
			sectorName !== 'Fallback' && sectorName.toLowerCase() === rawSector.toLowerCase()
	);

	return normalizedSector || null;
}

function normalizeSectorText(value) {
	if (typeof value !== 'string') {
		return null;
	}

	const normalizedValue = value.trim();

	return normalizedValue || null;
}

function createTradingStartDate(startDate) {
	const tradingStartDate = parseDate(startDate);

	snapDateForwardToTradingDay(tradingStartDate);

	return tradingStartDate;
}

function snapDateForwardToTradingDay(date) {
	while (!isTradingDay(date)) {
		date.setUTCDate(date.getUTCDate() + 1);
	}
}

function isTradingDay(date) {
	const dayOfWeek = date.getUTCDay();
	return dayOfWeek !== 0 && dayOfWeek !== 6;
}

function formatDate(date) {
	return date.toISOString().slice(0, 10);
}

function roundMetric(value) {
	return Number(value.toFixed(4));
}

function getMaxDrawdownMetrics(mockSeries) {
	let peakValue = mockSeries[0].portfolioValue;
	let maxDrawdown = 0;
	let maxDrawdownDollars = 0;

	for (const point of mockSeries) {
		peakValue = Math.max(peakValue, point.portfolioValue);

		const drawdownDollars = peakValue - point.portfolioValue;
		const drawdown = peakValue === 0 ? 0 : (point.portfolioValue - peakValue) / peakValue;

		if (drawdown < maxDrawdown) {
			maxDrawdown = drawdown;
			maxDrawdownDollars = drawdownDollars;
		}
	}

	return {
		maxDrawdown: roundMetric(maxDrawdown),
		maxDrawdownDollars: roundCurrency(maxDrawdownDollars)
	};
}

function roundCurrency(value) {
	return Number(value.toFixed(2));
}
