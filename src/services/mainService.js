const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const DEFAULT_MOCK_START_DATE = '2020-02-19';
const EODHD_BULK_LAST_DAY_URL = 'https://eodhd.com/api/eod-bulk-last-day/US';
const EODHD_REAL_TIME_URL = 'https://eodhd.com/api/real-time';
const EODHD_EOD_URL = 'https://eodhd.com/api/eod';
const EODHD_FUNDAMENTALS_URL = 'https://eodhd.com/api/fundamentals';
const BENCHMARK_ETF_DIRECTORY = path.resolve(__dirname, '../../data/benchmark-etfs-data');
const OPENAI_SIMPLE_FIX_MODEL = 'gpt-5.4-mini';
const CALENDAR_DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const HYPOTHETICAL_BASE_CURVE_WEIGHT = 0.7;
const HYPOTHETICAL_HEADLINE_CURVE_WEIGHT = 0.3;
const HYPOTHETICAL_OVERSHOOT_REMAINING_MULTIPLIER = 1.4;
const HYPOTHETICAL_MAX_SENSITIVITY = 1.2;
const HYPOTHETICAL_MIN_SENSITIVITY = 0.8;
const HYPOTHETICAL_DAILY_FLUCTUATION_LEVEL = 3;
const HYPOTHETICAL_BASE_MAX_WIGGLE_SCALE = 0.05;
const HYPOTHETICAL_BASE_WIGGLE_SHOCK_MULTIPLIER = 0.08;
const MOCK_PORTFOLIO_VALUES = [10000, 9840, 9400, 6880, 7340];
const MOCK_LOSS_CONTRIBUTIONS = [-0.14, -0.08, -0.046];
const sectorEtfMap = require('../../data/sector_etf_map.json');
const etfCategoryMap = require('../../data/etf_category_map.json');
const specialEtfBehaviorMap = require('../../data/special_etf_behavior_map.json');
const benchmarkEtfSeriesCache = new Map();
const etfCategoryBenchmarkSymbols = buildEtfCategoryBenchmarkSymbols(etfCategoryMap);
const etfCategoryLookup = buildEtfCategoryLookup(etfCategoryMap);
const specialEtfBehaviorLookup = buildSpecialEtfBehaviorLookup(specialEtfBehaviorMap);
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

	return buildPortfolioAnalysisResult({
		crisis,
		holdingSeries,
		fallbackUsage,
		omittedHoldings,
		warnings
	});
});

const analyzeHypotheticalUsersPortfolio = (exports.analyzeHypotheticalUsersPortfolio = async function analyzeHypotheticalUsersPortfolio({
	portfolio = [],
	crisis = {},
	nearestTradingDay,
	currentAdjustedClosePrices = {},
	companySectorResolutions = {}
} = {}) {
	const tradingDates = buildTradingDatesInRange({
		startDate: nearestTradingDay,
		endDate: crisis?.endDate
	});
	const historicalCalibrationProfiles = await fetchHypotheticalHistoricalCalibrationProfiles({
		portfolio,
		currentAdjustedClosePrices,
		companySectorResolutions,
		startDate: nearestTradingDay,
		endDate: crisis?.endDate,
		totalDays: tradingDates.length
	});
	const scenarioProfile = buildHypotheticalScenarioProfile({
		shape: crisis?.shape,
		headlines: crisis?.headlines,
		headlineTimeline: crisis?.headlineTimeline,
		overshootWindow: crisis?.overshootWindow,
		totalDays: tradingDates.length
	});
	const hypotheticalSeriesBuild = buildHypotheticalHoldingSeries({
		portfolio,
		currentAdjustedClosePrices,
		companySectorResolutions,
		historicalCalibrationProfiles,
		sectorShocks: crisis?.sectorShocks,
		tradingDates,
		scenarioProfile
	});
	const warnings = buildWarnings({
		fallbackUsage: hypotheticalSeriesBuild.fallbackUsage,
		omittedHoldings: hypotheticalSeriesBuild.omittedHoldings
	});

	return buildPortfolioAnalysisResult({
		crisis,
		holdingSeries: hypotheticalSeriesBuild.holdingSeries,
		fallbackUsage: hypotheticalSeriesBuild.fallbackUsage,
		omittedHoldings: hypotheticalSeriesBuild.omittedHoldings,
		warnings
	});
});

function buildPortfolioAnalysisResult({
	crisis = {},
	holdingSeries = [],
	fallbackUsage = [],
	omittedHoldings = [],
	warnings = []
}) {
	const series = aggregateHoldingSeries(holdingSeries);
	const summary = buildMockSummary(series, omittedHoldings.length);
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
}

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

const getRealtimePrice = (exports.getRealtimePrice = async function getRealtimePrice(symbol) {
	const normalizedSymbol = normalizeSymbol(symbol);

	if (!normalizedSymbol) {
		throw new Error('A symbol is required.');
	}

	const apiToken = process.env.EODHD_API_TOKEN;

	if (!apiToken) {
		throw new Error('EODHD_API_TOKEN is not configured.');
	}

	const requestUrl = new URL(`${EODHD_REAL_TIME_URL}/${normalizedSymbol}.US`);

	requestUrl.search = new URLSearchParams({
		api_token: apiToken,
		fmt: 'json'
	}).toString();

	const response = await fetch(requestUrl);

	if (!response.ok) {
		throw new Error(
			`EODHD real-time price request failed for ${normalizedSymbol} with status ${response.status}.`
		);
	}

	const quote = await response.json();

	if (!quote || typeof quote !== 'object' || Array.isArray(quote)) {
		throw new Error(`EODHD real-time price response for ${normalizedSymbol} was not an object.`);
	}

	if (typeof quote.close !== 'number') {
		throw new Error(
			`EODHD real-time price response for ${normalizedSymbol} did not include a numeric close.`
		);
	}

	return {
		ok: true,
		symbol: normalizedSymbol,
		code: typeof quote.code === 'string' ? quote.code : `${normalizedSymbol}.US`,
		price: quote.close,
		timestamp: typeof quote.timestamp === 'number' ? quote.timestamp : null,
		previousClose: typeof quote.previousClose === 'number' ? quote.previousClose : null,
		change: typeof quote.change === 'number' ? quote.change : null,
		changePercent: typeof quote.change_p === 'number' ? quote.change_p : null
	};
});

const fetchHistoricalAdjustedCloseSeries = (exports.fetchHistoricalAdjustedCloseSeries = async function fetchHistoricalAdjustedCloseSeries({
	portfolio = [],
	startDate,
	endDate
} = {}) {
	const symbols = getUniquePortfolioSymbols(portfolio);

	return fetchAdjustedCloseSeriesBySymbols({
		symbols,
		startDate,
		endDate
	});
});

async function fetchAdjustedCloseSeriesBySymbols({
	symbols = [],
	startDate,
	endDate
} = {}) {
	const normalizedSymbols = [...new Set(symbols.map((symbol) => normalizeSymbol(symbol)).filter(Boolean))];

	if (normalizedSymbols.length === 0) {
		return {};
	}

	const apiToken = process.env.EODHD_API_TOKEN;

	if (!apiToken) {
		throw new Error('EODHD_API_TOKEN is not configured.');
	}

	const fromDate = normalizeHistoricalStartDate(startDate);
	const toDate = getHistoricalWindowEndDate({ startDate: fromDate, endDate });
	const seriesEntries = await Promise.all(
		normalizedSymbols.map(async (symbol) => [
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
}

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
		warnings.push(buildFallbackWarningMessage(fallbackEntry));
	}

	for (const omittedHolding of omittedHoldings) {
		warnings.push(`${omittedHolding.symbol} was omitted: ${omittedHolding.reason}`);
	}

	return warnings;
}

function buildFallbackWarningMessage(fallbackEntry) {
	if (typeof fallbackEntry?.reason !== 'string') {
		return `${fallbackEntry.symbol} used ${fallbackEntry.source} fallback for the full crisis window.`;
	}

	if (fallbackEntry.reason === 'missing_etf_category') {
		return `${fallbackEntry.symbol} defaulted to ${fallbackEntry.source} for the hypothetical scenario because its ETF category was not mapped.`;
	}

	if (fallbackEntry.reason === 'missing_stock_sector') {
		return `${fallbackEntry.symbol} defaulted to ${fallbackEntry.source} for the hypothetical scenario because its stock sector lookup was unavailable.`;
	}

	if (fallbackEntry.reason === 'unknown_holding_type') {
		return `${fallbackEntry.symbol} defaulted to ${fallbackEntry.source} for the hypothetical scenario because its holding type was not recognized.`;
	}

	if (fallbackEntry.reason === 'missing_bucket_shock') {
		return `${fallbackEntry.symbol} defaulted to ${fallbackEntry.source} for the hypothetical scenario because no sector shock was configured for ${fallbackEntry.requestedBucket || 'its bucket'}.`;
	}

	return `${fallbackEntry.symbol} used ${fallbackEntry.source} fallback for the full crisis window.`;
}

function buildHypotheticalHoldingSeries({
	portfolio,
	currentAdjustedClosePrices,
	companySectorResolutions,
	historicalCalibrationProfiles,
	sectorShocks,
	tradingDates,
	scenarioProfile
}) {
	return portfolio.reduce(
		(result, holding) => {
			const hypotheticalEntry = buildHypotheticalHoldingSeriesEntry({
				holding,
				currentAdjustedClosePrices,
				companySectorResolutions,
				historicalCalibrationProfiles,
				sectorShocks,
				tradingDates,
				scenarioProfile
			});

			if (hypotheticalEntry.omittedHolding) {
				result.omittedHoldings.push(hypotheticalEntry.omittedHolding);
				return result;
			}

			result.holdingSeries.push(hypotheticalEntry.holdingSeriesEntry);

			if (hypotheticalEntry.fallbackUsageEntry) {
				result.fallbackUsage.push(hypotheticalEntry.fallbackUsageEntry);
			}

			return result;
		},
		{
			holdingSeries: [],
			fallbackUsage: [],
			omittedHoldings: []
		}
	);
}

function buildHypotheticalHoldingSeriesEntry({
	holding,
	currentAdjustedClosePrices,
	companySectorResolutions,
	historicalCalibrationProfiles,
	sectorShocks,
	tradingDates,
	scenarioProfile
}) {
	const symbol = normalizeSymbol(holding?.symbol);

	if (!symbol) {
		return {
			omittedHolding: {
				symbol: 'unknown',
				reason: 'The holding symbol was missing.'
			}
		};
	}

	const quantity = normalizeQuantity(holding?.quantity);

	if (quantity === null) {
		return {
			omittedHolding: {
				symbol,
				reason: 'The holding quantity was invalid.'
			}
		};
	}

	const currentAdjustedClose = currentAdjustedClosePrices[symbol]?.adjustedClose;

	if (typeof currentAdjustedClose !== 'number' || currentAdjustedClose <= 0) {
		return {
			omittedHolding: {
				symbol,
				reason: 'No current adjusted-close price was available.'
			}
		};
	}

	const shockContext = getHypotheticalShockContext({
		holding,
		symbol,
		companySectorResolutions,
		sectorShocks
	});
	const startValue = roundCurrency(quantity * currentAdjustedClose);

	if (usesUnderlyingBasedSpecialEtfBehavior(shockContext.specialEtfBehavior)) {
		const leveragedHoldingSeries = buildLeveragedEtfHoldingSeries({
			startValue,
			tradingDates,
			scenarioProfile,
			shockContext,
			historicalCalibrationProfiles
		});

		return {
			holdingSeriesEntry: {
				symbol,
				source: 'hypothetical',
				fallbackSymbol: shockContext.usedFallback ? shockContext.fallbackSource : null,
				shockBucket: shockContext.bucket,
				shockMultiplier: shockContext.shockMultiplier,
				specialEtfBehavior: shockContext.specialEtfBehavior,
				historicalSensitivityScore: leveragedHoldingSeries.historicalSensitivityScore,
				underlyingSymbol: leveragedHoldingSeries.underlyingSymbol,
				startValue,
				series: leveragedHoldingSeries.series
			},
			fallbackUsageEntry: shockContext.usedFallback
				? {
					symbol,
					used: true,
					source: shockContext.fallbackSource,
					holdingType: shockContext.holdingType,
					requestedBucket: shockContext.originalBucket,
					resolvedBucket: shockContext.bucket,
					reason: shockContext.fallbackReason
				}
				: null
		};
	}

	const historicalCalibrationProfile = getHistoricalCalibrationProfile({
		symbol,
		historicalCalibrationProfiles
	});
	const historicalSensitivityScore = historicalCalibrationProfile.sensitivityScore;
	const adjustedShockValue = roundMetric(
		shockContext.shockValue * historicalSensitivityScore * shockContext.shockMultiplier
	);
	const cumulativeReturns = buildHypotheticalCumulativeReturns({
		adjustedShockValue,
		scenarioProfile,
		totalDays: tradingDates.length,
		volatilityCurve: historicalCalibrationProfile.volatilityCurve
	});
	const series = [];

	for (let index = 0; index < tradingDates.length; index += 1) {
		const cumulativeReturn = cumulativeReturns[index] || 0;
		const valueMultiplier = Math.max(0.01, 1 + cumulativeReturn);
		const holdingValue = roundCurrency(startValue * valueMultiplier);
		const previousValue = series.length === 0 ? holdingValue : series[series.length - 1].holdingValue;

		series.push({
			date: tradingDates[index],
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
		holdingSeriesEntry: {
			symbol,
			source: 'hypothetical',
			fallbackSymbol: shockContext.usedFallback ? shockContext.fallbackSource : null,
			shockBucket: shockContext.bucket,
			shockMultiplier: shockContext.shockMultiplier,
			specialEtfBehavior: shockContext.specialEtfBehavior,
			historicalSensitivityScore,
			startValue,
			series
		},
		fallbackUsageEntry: shockContext.usedFallback
			? {
				symbol,
				used: true,
				source: shockContext.fallbackSource,
				holdingType: shockContext.holdingType,
				requestedBucket: shockContext.originalBucket,
				resolvedBucket: shockContext.bucket,
				reason: shockContext.fallbackReason
			}
			: null
	};
}

function buildHypotheticalCumulativeReturns({
	adjustedShockValue,
	scenarioProfile,
	totalDays,
	volatilityCurve
}) {
	if (typeof totalDays !== 'number' || totalDays <= 0) {
		return [];
	}

	const targetCumulativeReturns = Array.from({ length: totalDays }, (_, index) => {
		const progress =
			typeof scenarioProfile?.progressCurve?.[index] === 'number'
				? scenarioProfile.progressCurve[index]
				: 0;
		const overshoot =
			typeof scenarioProfile?.overshootCurve?.[index] === 'number'
				? scenarioProfile.overshootCurve[index]
				: 0;

		return getHypotheticalCumulativeReturnAtDay({
			adjustedShockValue,
			progress,
			overshoot
		});
	});
	const wiggleScale = getHypotheticalWiggleScale(adjustedShockValue);

	if (!Array.isArray(volatilityCurve) || volatilityCurve.length === 0 || wiggleScale === 0) {
		return targetCumulativeReturns;
	}

	return targetCumulativeReturns.map((targetCumulativeReturn, index) =>
		roundMetric(
			targetCumulativeReturn +
				(typeof volatilityCurve[index] === 'number' ? volatilityCurve[index] : 0) * wiggleScale
		)
	);
}

function getHypotheticalCumulativeReturnAtDay({
	adjustedShockValue,
	progress,
	overshoot
}) {
	if (typeof adjustedShockValue !== 'number') {
		return 0;
	}

	const anchoredReturn = adjustedShockValue * (typeof progress === 'number' ? progress : 0);
	const remainingReturnToTarget = adjustedShockValue - anchoredReturn;
	const overshootReturn =
		remainingReturnToTarget *
		HYPOTHETICAL_OVERSHOOT_REMAINING_MULTIPLIER *
		(typeof overshoot === 'number' ? overshoot : 0);

	return roundMetric(anchoredReturn + overshootReturn);
}

async function fetchHypotheticalHistoricalCalibrationProfiles({
	portfolio = [],
	currentAdjustedClosePrices = {},
	companySectorResolutions = {},
	startDate,
	endDate,
	totalDays
} = {}) {
	if (!Array.isArray(portfolio) || portfolio.length === 0) {
		return {};
	}

	const calibrationWindow = getHypotheticalCalibrationWindow({
		currentAdjustedClosePrices,
		startDate,
		endDate
	});
	const calibrationPlan = buildHypotheticalCalibrationPlan({
		portfolio,
		companySectorResolutions
	});
	const calibrationSymbols = [...new Set(
		calibrationPlan.flatMap((entry) => [entry.symbol, entry.benchmarkSymbol])
	)].filter(Boolean);
	const calibrationSeriesBySymbol = await fetchAdjustedCloseSeriesBySymbols({
		symbols: calibrationSymbols,
		startDate: calibrationWindow.startDate,
		endDate: calibrationWindow.endDate
	});

	return Object.fromEntries(
		calibrationPlan.map((entry) => [
			entry.symbol,
			buildHistoricalCalibrationProfile({
				historicalSeries: calibrationSeriesBySymbol[entry.symbol],
				benchmarkSeries: calibrationSeriesBySymbol[entry.benchmarkSymbol],
				totalDays
			})
		])
	);
}

function buildHistoricalCalibrationProfile({
	historicalSeries,
	benchmarkSeries,
	totalDays
}) {
	return {
		sensitivityScore: calculateHistoricalSensitivityScore({
			historicalSeries,
			benchmarkSeries
		}),
		volatilityCurve: buildHistoricalVolatilityCurve({
			historicalSeries,
			totalDays
		})
	};
}

function buildHypotheticalCalibrationPlan({
	portfolio = [],
	companySectorResolutions = {}
}) {
	const calibrationEntries = portfolio.flatMap((holding) => {
			const symbol = normalizeSymbol(holding?.symbol);

			if (!symbol) {
				return [];
			}

			const bucketContext = getHypotheticalBucketContext({
				holding,
				symbol,
				companySectorResolutions
			});
			const benchmarkSymbol = getHistoricalSensitivityBenchmarkSymbol(bucketContext.bucket);

			if (usesUnderlyingBasedSpecialEtfBehavior(bucketContext.specialEtfBehavior)) {
				return [
					{
						symbol,
						benchmarkSymbol: bucketContext.specialEtfBehavior.underlyingSymbol
					},
					{
						symbol: bucketContext.specialEtfBehavior.underlyingSymbol,
						benchmarkSymbol
					}
				];
			}

			return benchmarkSymbol
				? [
					{
						symbol,
						benchmarkSymbol
					}
				]
				: [];
		});

	return getUniqueCalibrationPlanEntries(calibrationEntries);
}

function getUniqueCalibrationPlanEntries(calibrationEntries) {
	if (!Array.isArray(calibrationEntries)) {
		return [];
	}

	const uniqueEntries = new Map();

	for (const entry of calibrationEntries) {
		if (!entry || !entry.symbol || !entry.benchmarkSymbol) {
			continue;
		}

		uniqueEntries.set(`${entry.symbol}:${entry.benchmarkSymbol}`, entry);
	}

	return [...uniqueEntries.values()];
}

function getHypotheticalCalibrationWindow({
	currentAdjustedClosePrices,
	startDate,
	endDate
}) {
	const normalizedStartDate = normalizeHistoricalStartDate(startDate);
	const normalizedEndDate = getHistoricalWindowEndDate({
		startDate: normalizedStartDate,
		endDate
	});
	const calibrationEndDate = getCalibrationAnchorDate(currentAdjustedClosePrices);
	const calendarDayCount = getInclusiveCalendarDayCount({
		startDate: normalizedStartDate,
		endDate: normalizedEndDate
	});

	return {
		startDate: shiftDateByCalendarDays(calibrationEndDate, -(calendarDayCount - 1)),
		endDate: calibrationEndDate
	};
}

function getCalibrationAnchorDate(currentAdjustedClosePrices) {
	const availableDates = Object.values(currentAdjustedClosePrices)
		.map((priceEntry) => (typeof priceEntry?.date === 'string' ? priceEntry.date : null))
		.filter(Boolean)
		.sort();

	if (availableDates.length > 0) {
		return availableDates[availableDates.length - 1];
	}

	return formatDate(new Date());
}

function getInclusiveCalendarDayCount({ startDate, endDate }) {
	const parsedStartDate = parseDate(startDate);
	const parsedEndDate = parseDate(endDate);
	const differenceInMilliseconds = parsedEndDate.getTime() - parsedStartDate.getTime();

	if (differenceInMilliseconds <= 0) {
		return 1;
	}

	return Math.floor(differenceInMilliseconds / CALENDAR_DAY_IN_MILLISECONDS) + 1;
}

function shiftDateByCalendarDays(dateString, dayDelta) {
	const shiftedDate = parseDate(dateString);

	shiftedDate.setUTCDate(shiftedDate.getUTCDate() + dayDelta);

	return formatDate(shiftedDate);
}

function calculateHistoricalSensitivityScore({
	historicalSeries,
	benchmarkSeries
}) {
	const historicalVolatility = calculateSeriesVolatility(historicalSeries);
	const benchmarkVolatility = calculateSeriesVolatility(benchmarkSeries);

	if (
		typeof historicalVolatility !== 'number' ||
		typeof benchmarkVolatility !== 'number' ||
		benchmarkVolatility <= 0
	) {
		return 1;
	}

	return clampNumber(
		historicalVolatility / benchmarkVolatility,
		HYPOTHETICAL_MIN_SENSITIVITY,
		HYPOTHETICAL_MAX_SENSITIVITY
	);
}

function calculateSeriesVolatility(series) {
	const dailyReturns = getAdjustedCloseDailyReturns(series);

	if (dailyReturns.length === 0) {
		return null;
	}

	const averageReturn =
		dailyReturns.reduce((sum, dailyReturn) => sum + dailyReturn, 0) / dailyReturns.length;
	const variance =
		dailyReturns.reduce(
			(sum, dailyReturn) => sum + (dailyReturn - averageReturn) ** 2,
			0
		) / dailyReturns.length;

	return Math.sqrt(variance);
}

function buildHistoricalVolatilityCurve({ historicalSeries, totalDays }) {
	if (typeof totalDays !== 'number' || totalDays <= 0) {
		return [];
	}

	if (totalDays === 1) {
		return [0];
	}

	const dailyReturns = getAdjustedCloseDailyReturns(historicalSeries);

	if (dailyReturns.length === 0) {
		return Array.from({ length: totalDays }, () => 0);
	}

	const cumulativeReturns = [0];
	let runningTotal = 0;

	for (const dailyReturn of dailyReturns) {
		runningTotal += dailyReturn;
		cumulativeReturns.push(runningTotal);
	}

	const lastCurveIndex = cumulativeReturns.length - 1;
	const detrendedCurve = cumulativeReturns.map((curveValue, curveIndex) => {
		const straightLineValue =
			lastCurveIndex === 0
				? 0
				: cumulativeReturns[lastCurveIndex] * (curveIndex / lastCurveIndex);

		return curveValue - straightLineValue;
	});
	const maxAbsoluteValue = Math.max(
		...detrendedCurve.map((curveValue) => Math.abs(curveValue))
	);
	const normalizedCurve =
		maxAbsoluteValue > 0
			? detrendedCurve.map((curveValue) => curveValue / maxAbsoluteValue)
			: detrendedCurve.map(() => 0);

	return resampleCurve({
		curve: normalizedCurve,
		totalPoints: totalDays
	});
}

function getAdjustedCloseDailyReturns(series) {
	if (!Array.isArray(series) || series.length < 2) {
		return [];
	}

	const dailyReturns = [];

	for (let index = 1; index < series.length; index += 1) {
		const previousAdjustedClose = series[index - 1]?.adjustedClose;
		const currentAdjustedClose = series[index]?.adjustedClose;

		if (
			typeof previousAdjustedClose !== 'number' ||
			typeof currentAdjustedClose !== 'number' ||
			previousAdjustedClose <= 0
		) {
			continue;
		}

		dailyReturns.push((currentAdjustedClose - previousAdjustedClose) / previousAdjustedClose);
	}

	return dailyReturns;
}

function getHistoricalCalibrationProfile({
	symbol,
	historicalCalibrationProfiles
}) {
	const calibrationProfile = historicalCalibrationProfiles?.[symbol];

	if (!calibrationProfile || typeof calibrationProfile !== 'object') {
		return {
			sensitivityScore: 1,
			volatilityCurve: []
		};
	}

	return {
		sensitivityScore:
			typeof calibrationProfile.sensitivityScore === 'number'
				? calibrationProfile.sensitivityScore
				: 1,
		volatilityCurve: Array.isArray(calibrationProfile.volatilityCurve)
			? calibrationProfile.volatilityCurve
			: []
	};
}


function buildLeveragedEtfHoldingSeries({
	startValue,
	tradingDates,
	scenarioProfile,
	shockContext,
	historicalCalibrationProfiles
}) {
	const underlyingSymbol = shockContext.specialEtfBehavior.underlyingSymbol;
	const underlyingCalibrationProfile = getHistoricalCalibrationProfile({
		symbol: underlyingSymbol,
		historicalCalibrationProfiles
	});
	const adjustedShockValue = roundMetric(
		shockContext.shockValue * underlyingCalibrationProfile.sensitivityScore
	);
	const underlyingCumulativeReturns = buildHypotheticalCumulativeReturns({
		adjustedShockValue,
		scenarioProfile,
		totalDays: tradingDates.length,
		volatilityCurve: underlyingCalibrationProfile.volatilityCurve
	});
	const series = buildLeveragedSeriesFromUnderlyingReturns({
		startValue,
		tradingDates,
		underlyingCumulativeReturns,
		leverageMultiplier: shockContext.shockMultiplier
	});

	return {
		underlyingSymbol,
		historicalSensitivityScore: underlyingCalibrationProfile.sensitivityScore,
		series
	};
}

function buildLeveragedSeriesFromUnderlyingReturns({
	startValue,
	tradingDates,
	underlyingCumulativeReturns,
	leverageMultiplier
}) {
	const series = [];

	for (let index = 0; index < tradingDates.length; index += 1) {
		if (index === 0) {
			series.push({
				date: tradingDates[index],
				holdingValue: startValue,
				dailyReturn: 0,
				cumulativeReturn: 0
			});
			continue;
		}

		const previousHoldingValue = series[index - 1].holdingValue;
		const underlyingPreviousMultiplier = getHypotheticalValueMultiplier(
			underlyingCumulativeReturns[index - 1] || 0
		);
		const underlyingCurrentMultiplier = getHypotheticalValueMultiplier(
			underlyingCumulativeReturns[index] || 0
		);
		const underlyingDailyReturn =
			underlyingPreviousMultiplier <= 0
				? 0
				: (underlyingCurrentMultiplier - underlyingPreviousMultiplier) /
					underlyingPreviousMultiplier;
		const leveragedDailyReturn = roundMetric(underlyingDailyReturn * leverageMultiplier);
		const holdingValue = roundCurrency(
			previousHoldingValue * Math.max(0, 1 + leveragedDailyReturn)
		);

		series.push({
			date: tradingDates[index],
			holdingValue,
			dailyReturn:
				previousHoldingValue === 0
					? 0
					: roundMetric((holdingValue - previousHoldingValue) / previousHoldingValue),
			cumulativeReturn:
				startValue === 0 ? 0 : roundMetric((holdingValue - startValue) / startValue)
		});
	}

	return series;
}
function getHypotheticalWiggleScale(adjustedShockValue) {
	if (typeof adjustedShockValue !== 'number' || adjustedShockValue === 0) {
		return 0;
	}

	const wiggleShockMultiplier =
		HYPOTHETICAL_BASE_WIGGLE_SHOCK_MULTIPLIER * HYPOTHETICAL_DAILY_FLUCTUATION_LEVEL;
	const maxWiggleScale =
		HYPOTHETICAL_BASE_MAX_WIGGLE_SCALE * HYPOTHETICAL_DAILY_FLUCTUATION_LEVEL;

	return clampNumber(
		Math.abs(adjustedShockValue) * wiggleShockMultiplier,
		0,
		maxWiggleScale
	);
}

function getHypotheticalValueMultiplier(cumulativeReturn) {
	return Math.max(0.01, 1 + (typeof cumulativeReturn === 'number' ? cumulativeReturn : 0));
}

function resampleCurve({ curve, totalPoints }) {
	if (!Array.isArray(curve) || curve.length === 0 || typeof totalPoints !== 'number' || totalPoints <= 0) {
		return [];
	}

	if (totalPoints === 1) {
		return [0];
	}

	if (curve.length === 1) {
		return Array.from({ length: totalPoints }, () => 0);
	}

	const lastCurveIndex = curve.length - 1;

	return Array.from({ length: totalPoints }, (_, pointIndex) => {
		if (pointIndex === 0 || pointIndex === totalPoints - 1) {
			return 0;
		}

		const curvePosition = (pointIndex / (totalPoints - 1)) * lastCurveIndex;
		const leftIndex = Math.floor(curvePosition);
		const rightIndex = Math.ceil(curvePosition);

		if (leftIndex === rightIndex) {
			return roundMetric(curve[leftIndex] || 0);
		}

		const leftValue = curve[leftIndex] || 0;
		const rightValue = curve[rightIndex] || 0;
		const interpolationRatio = curvePosition - leftIndex;

		return roundMetric(leftValue + (rightValue - leftValue) * interpolationRatio);
	});
}

function getHypotheticalShockContext({
	holding,
	symbol,
	companySectorResolutions,
	sectorShocks
}) {
	return buildHypotheticalShockContext({
		bucketContext: getHypotheticalBucketContext({
			holding,
			symbol,
			companySectorResolutions
		}),
		sectorShocks
	});
}

function getHypotheticalBucketContext({ holding, symbol, companySectorResolutions }) {
	if (isStockHolding(holding)) {
		const preferredBucket = getShockBucketForCompanySector(
			companySectorResolutions[symbol]?.normalizedSector
		);

		return {
			originalBucket: preferredBucket,
			bucket: preferredBucket || 'broad_etf',
			holdingType: 'stock',
			usedFallback: !preferredBucket,
			fallbackSource: preferredBucket ? null : 'broad_etf',
			fallbackReason: preferredBucket ? null : 'missing_stock_sector'
		};
	}

	if (isEtfHolding(holding)) {
		const specialEtfBehavior = getSpecialEtfBehavior(symbol);

		if (specialEtfBehavior) {
			return {
				originalBucket: specialEtfBehavior.bucket,
				bucket: specialEtfBehavior.bucket,
				holdingType: 'etf',
				usedFallback: false,
				fallbackSource: null,
				fallbackReason: null,
				specialEtfBehavior
			};
		}

		const preferredBucket = etfCategoryLookup[symbol] || null;

		return {
			originalBucket: preferredBucket,
			bucket: preferredBucket || 'broad_etf',
			holdingType: 'etf',
			usedFallback: !preferredBucket,
			fallbackSource: preferredBucket ? null : 'broad_etf',
			fallbackReason: preferredBucket ? null : 'missing_etf_category',
			specialEtfBehavior: null
		};
	}

	return {
		originalBucket: null,
		bucket: 'broad_etf',
		holdingType: 'unknown',
		usedFallback: true,
		fallbackSource: 'broad_etf',
		fallbackReason: 'unknown_holding_type',
		specialEtfBehavior: null
	};
}

function buildHypotheticalShockContext({ bucketContext, sectorShocks }) {
	const shockValue = getShockValueForBucket({
		bucket: bucketContext.bucket,
		sectorShocks,
		holdingType: bucketContext.holdingType
	});

	if (typeof shockValue === 'number') {
		return {
			bucket: bucketContext.bucket,
			shockValue,
			shockMultiplier: getSpecialEtfShockMultiplier(bucketContext.specialEtfBehavior),
			holdingType: bucketContext.holdingType,
			originalBucket: bucketContext.originalBucket,
			usedFallback: bucketContext.usedFallback,
			fallbackSource: bucketContext.usedFallback ? bucketContext.fallbackSource : null,
			fallbackReason: bucketContext.usedFallback ? bucketContext.fallbackReason : null,
			specialEtfBehavior: bucketContext.specialEtfBehavior
		};
	}

	const broadMarketShock = getShockValueForBucket({
		bucket: 'broad_etf',
		sectorShocks,
		holdingType: bucketContext.holdingType
		});

	return {
		bucket: 'broad_etf',
		shockValue: typeof broadMarketShock === 'number' ? broadMarketShock : 0,
		shockMultiplier: getSpecialEtfShockMultiplier(bucketContext.specialEtfBehavior),
			holdingType: bucketContext.holdingType,
			originalBucket: bucketContext.originalBucket,
		usedFallback: true,
		fallbackSource: 'broad_etf',
		fallbackReason: bucketContext.usedFallback
			? bucketContext.fallbackReason
			: 'missing_bucket_shock',
		specialEtfBehavior: bucketContext.specialEtfBehavior
	};
}

function getHistoricalSensitivityBenchmarkSymbol(bucket) {
	const stockBenchmarkSymbolsByBucket = {
		basic_materials: 'XLB',
		communications: 'IYZ',
		consumer: 'XLY',
		energy: 'XLE',
		financials: 'XLF',
		healthcare: 'XLV',
		industrials: 'XLI',
		real_estate: 'IYR',
		tech: 'XLK',
		utilities: 'XLU'
	};

	if (typeof bucket !== 'string') {
		return sectorEtfMap.Fallback || 'SPY';
	}

	return stockBenchmarkSymbolsByBucket[bucket] || etfCategoryBenchmarkSymbols[bucket] || sectorEtfMap.Fallback || 'SPY';
}

function getShockValueForBucket({ bucket, sectorShocks, holdingType }) {
	if (!sectorShocks || typeof sectorShocks !== 'object' || typeof bucket !== 'string') {
		return null;
	}

	const candidateKeys = [];

	if (holdingType === 'etf' && bucket === 'tech') {
		candidateKeys.push('tech_etf');
	}

	candidateKeys.push(bucket);

	for (const shockKey of [...new Set(candidateKeys)]) {
		if (typeof sectorShocks[shockKey] === 'number') {
			return sectorShocks[shockKey];
		}
	}

	return null;
}

function getShockBucketForCompanySector(normalizedSector) {
	if (typeof normalizedSector !== 'string') {
		return null;
	}

	const stockShockBucketMap = {
		'Basic Materials': 'basic_materials',
		'Communication Services': 'communications',
		'Consumer Cyclical': 'consumer',
		'Consumer Defensive': 'consumer',
		Energy: 'energy',
		'Financial Services': 'financials',
		Healthcare: 'healthcare',
		Industrials: 'industrials',
		'Real Estate': 'real_estate',
		Technology: 'tech',
		Utilities: 'utilities'
	};

	return stockShockBucketMap[normalizedSector] || null;
}

function buildTradingDatesInRange({ startDate, endDate }) {
	const normalizedStartDate = normalizeHistoricalStartDate(startDate);
	const normalizedEndDate = getHistoricalWindowEndDate({
		startDate: normalizedStartDate,
		endDate
	});
	const tradingDates = [];
	const cursorDate = parseDate(normalizedStartDate);
	const lastDate = parseDate(normalizedEndDate);

	snapDateForwardToTradingDay(cursorDate);

	while (cursorDate.getTime() <= lastDate.getTime()) {
		if (isTradingDay(cursorDate)) {
			tradingDates.push(formatDate(cursorDate));
		}

		cursorDate.setUTCDate(cursorDate.getUTCDate() + 1);
	}

	return tradingDates.length > 0 ? tradingDates : [formatDate(parseDate(normalizedStartDate))];
}

function buildHypotheticalScenarioProfile({
	shape,
	headlines,
	headlineTimeline,
	overshootWindow,
	totalDays
}) {
	if (typeof totalDays !== 'number' || totalDays <= 0) {
		return {
			progressCurve: [],
			overshootCurve: []
		};
	}

	if (totalDays === 1) {
		return {
			progressCurve: [0],
			overshootCurve: [0]
		};
	}

	const baseCurve = Array.from({ length: totalDays }, (_, index) => {
		const progress = index / (totalDays - 1);
		return roundMetric(getScenarioCurveValue({ shape, progress }));
	});
	const headlineCurveComponents = buildHeadlineCurveComponents({
		headlines,
		headlineTimeline,
		totalDays,
		overshootWindow
	});

	if (headlineCurveComponents.timingCurve.length === 0) {
		return {
			progressCurve: baseCurve,
			overshootCurve: Array.from({ length: totalDays }, () => 0)
		};
	}

	return {
		progressCurve: baseCurve.map((baseValue, index) =>
			roundMetric(
				baseValue * HYPOTHETICAL_BASE_CURVE_WEIGHT +
					headlineCurveComponents.timingCurve[index] * HYPOTHETICAL_HEADLINE_CURVE_WEIGHT
			)
		),
		overshootCurve: headlineCurveComponents.pressureCurve
	};
}

function buildHeadlineCurveComponents({
	headlines,
	headlineTimeline,
	overshootWindow,
	totalDays
}) {
	if (totalDays <= 1) {
		return {
			timingCurve: [],
			pressureCurve: []
		};
	}

	const headlineEntries = buildHypotheticalHeadlineEntries({
		headlines,
		headlineTimeline
	});

	if (headlineEntries.length === 0) {
		return {
			timingCurve: [],
			pressureCurve: []
		};
	}

	const spread = Math.max(0.08, 1 / Math.max(headlineEntries.length * 2, 2));
	const dailyImpactWeights = Array.from({ length: totalDays }, () => 1);
	const headlinePressureWeights = Array.from({ length: totalDays }, () => 0);

	for (const headlineEntry of headlineEntries) {
		const impactWeight = getHeadlineImpactWeight(headlineEntry.headline);
		const anchor = headlineEntry.position;

		for (let dayIndex = 0; dayIndex < totalDays; dayIndex += 1) {
			const progress = dayIndex / (totalDays - 1);
			const pulseWeight = getHeadlinePulseWeight({ progress, anchor, spread });

			dailyImpactWeights[dayIndex] += impactWeight * pulseWeight;
			headlinePressureWeights[dayIndex] += impactWeight * pulseWeight;
		}
	}

	return {
		timingCurve: normalizeImpactWeightsToCurve(dailyImpactWeights),
		pressureCurve: normalizeHeadlinePressureCurve(headlinePressureWeights, overshootWindow)
	};
}

function buildHypotheticalHeadlineEntries({ headlines, headlineTimeline }) {
	const normalizedHeadlines = normalizeHypotheticalHeadlines(headlines);

	if (normalizedHeadlines.length === 0) {
		return [];
	}

	const customHeadlineEntries = buildCustomHeadlineEntries({
		headlines: normalizedHeadlines,
		headlineTimeline
	});

	if (customHeadlineEntries.length > 0) {
		return customHeadlineEntries;
	}

	const timelineAnchors = buildHeadlineTimelineAnchors(normalizedHeadlines.length);

	return normalizedHeadlines.map((headline, index) => ({
		headline,
		position: timelineAnchors[index]
	}));
}

function normalizeHypotheticalHeadlines(headlines) {
	if (!Array.isArray(headlines)) {
		return [];
	}

	return headlines
		.filter((headline) => typeof headline === 'string')
		.map((headline) => headline.trim())
		.filter(Boolean);
}

function buildCustomHeadlineEntries({ headlines, headlineTimeline }) {
	if (!Array.isArray(headlineTimeline) || headlineTimeline.length !== headlines.length) {
		return [];
	}

	const customHeadlineEntries = headlineTimeline.map((timelineEntry, index) => {
		if (!timelineEntry || typeof timelineEntry !== 'object' || Array.isArray(timelineEntry)) {
			return null;
		}

		const position = normalizeHeadlineTimelinePosition(timelineEntry.position);

		if (position === null) {
			return null;
		}

		const timelineHeadline =
			typeof timelineEntry.headline === 'string' && timelineEntry.headline.trim()
				? timelineEntry.headline.trim()
				: headlines[index];

		return {
			headline: timelineHeadline,
			position
		};
	});

	return customHeadlineEntries.every(Boolean) ? customHeadlineEntries : [];
}

function normalizeHeadlineTimelinePosition(position) {
	if (typeof position !== 'number' || !Number.isFinite(position)) {
		return null;
	}

	if (position < 0 || position > 1) {
		return null;
	}

	return position;
}

function buildHeadlineTimelineAnchors(headlineCount) {
	if (headlineCount <= 0) {
		return [];
	}

	if (headlineCount === 1) {
		return [0.5];
	}

	return Array.from({ length: headlineCount }, (_, index) => 0.1 + (0.8 * index) / (headlineCount - 1));
}

function getHeadlineImpactWeight(headline) {
	const normalizedHeadline = headline.toLowerCase();
	const highImpactMatches = countHeadlineKeywordMatches(normalizedHeadline, [
		'crash',
		'collapse',
		'collapses',
		'plummet',
		'plummets',
		'panic',
		'panics',
		'freeze',
		'freezes',
		'conflict',
		'war',
		'outbreak',
		'pandemic',
		'burst',
		'crunch',
		'layoffs',
		'demand collapses',
		'valuations',
		'decline',
		'funding crunch'
	]);
	const easingMatches = countHeadlineKeywordMatches(normalizedHeadline, [
		'stabilize',
		'stabilizes',
		'stabilized',
		'ease',
		'eases',
		'ceasefire',
		'peace',
		'negotiation',
		'negotiations',
		'containment measures ease',
		'markets stabilize'
	]);

	return clampNumber(0.25 + highImpactMatches * 0.18 - easingMatches * 0.12, 0.08, 1);
}

function countHeadlineKeywordMatches(headline, keywords) {
	if (typeof headline !== 'string' || !Array.isArray(keywords)) {
		return 0;
	}

	return keywords.reduce(
		(totalMatches, keyword) =>
			totalMatches + (typeof keyword === 'string' && headline.includes(keyword) ? 1 : 0),
		0
	);
}

function getHeadlinePulseWeight({ progress, anchor, spread }) {
	if (
		typeof progress !== 'number' ||
		typeof anchor !== 'number' ||
		typeof spread !== 'number' ||
		spread <= 0
	) {
		return 0;
	}

	const distance = Math.abs(progress - anchor);

	if (distance >= spread) {
		return 0;
	}

	return 1 - distance / spread;
}

function normalizeImpactWeightsToCurve(dailyImpactWeights) {
	if (!Array.isArray(dailyImpactWeights) || dailyImpactWeights.length === 0) {
		return [];
	}

	const cumulativeWeights = [];
	let runningTotal = 0;

	for (const weight of dailyImpactWeights) {
		runningTotal += typeof weight === 'number' ? weight : 0;
		cumulativeWeights.push(runningTotal);
	}

	const startingValue = cumulativeWeights[0];
	const endingValue = cumulativeWeights[cumulativeWeights.length - 1];

	if (endingValue <= startingValue) {
		return Array.from({ length: dailyImpactWeights.length }, (_, index) =>
			dailyImpactWeights.length === 1 ? 0 : index / (dailyImpactWeights.length - 1)
		);
	}

	return cumulativeWeights.map((value) => (value - startingValue) / (endingValue - startingValue));
}

function normalizeHeadlinePressureCurve(headlinePressureWeights, overshootWindow) {
	if (!Array.isArray(headlinePressureWeights) || headlinePressureWeights.length === 0) {
		return [];
	}

	const lastIndex = headlinePressureWeights.length - 1;
	const weightedPressure = headlinePressureWeights.map((weight, index) => {
		if (index === 0 || index === lastIndex) {
			return 0;
		}

		const progress = lastIndex === 0 ? 0 : index / lastIndex;

		return weight * getHeadlineOvershootEnvelope(progress, overshootWindow);
	});
	const maxPressure = Math.max(...weightedPressure);

	if (maxPressure <= 0) {
		return Array.from({ length: headlinePressureWeights.length }, () => 0);
	}

	return weightedPressure.map((weight) => roundMetric(weight / maxPressure));
}

function getHeadlineOvershootEnvelope(progress, overshootWindow) {
	return interpolateCurvePoints(
		progress,
		getHeadlineOvershootEnvelopePoints(overshootWindow)
	);
}

function getHeadlineOvershootEnvelopePoints(overshootWindow) {
	const normalizedOvershootWindow = normalizeHypotheticalOvershootWindow(overshootWindow);

	if (!normalizedOvershootWindow) {
		return [
			[0, 0],
			[0.32, 0],
			[0.72, 1],
			[1, 0]
		];
	}

	return [
		[0, 0],
		[normalizedOvershootWindow.start, 0],
		[normalizedOvershootWindow.peak, 1],
		[normalizedOvershootWindow.end, 0],
		[1, 0]
	];
}

function normalizeHypotheticalOvershootWindow(overshootWindow) {
	if (!overshootWindow || typeof overshootWindow !== 'object' || Array.isArray(overshootWindow)) {
		return null;
	}

	const start = normalizeHeadlineTimelinePosition(overshootWindow.start);
	const peak = normalizeHeadlineTimelinePosition(overshootWindow.peak);
	const end = normalizeHeadlineTimelinePosition(overshootWindow.end);

	if (start === null || peak === null || end === null) {
		return null;
	}

	if (!(start < peak && peak < end)) {
		return null;
	}

	return {
		start,
		peak,
		end
	};
}

function getScenarioCurveValue({ shape, progress }) {
	const normalizedShape = typeof shape === 'string' ? shape.toLowerCase() : 'slow_grind';

	if (normalizedShape === 'cliff') {
		return interpolateCurvePoints(progress, [
			[0, 0],
			[0.12, 0.6],
			[0.3, 0.9],
			[1, 1]
		]);
	}

	if (normalizedShape === 'double_dip') {
		return interpolateCurvePoints(progress, [
			[0, 0],
			[0.3, 0.72],
			[0.55, 0.45],
			[0.82, 0.92],
			[1, 1]
		]);
	}

	return interpolateCurvePoints(progress, [
		[0, 0],
		[0.42, 0.18],
		[0.76, 0.7],
		[1, 1]
	]);
}

function interpolateCurvePoints(progress, points) {
	if (!Array.isArray(points) || points.length === 0) {
		return progress;
	}

	if (progress <= points[0][0]) {
		return points[0][1];
	}

	for (let index = 1; index < points.length; index += 1) {
		const [leftX, leftY] = points[index - 1];
		const [rightX, rightY] = points[index];

		if (progress <= rightX) {
			const range = rightX - leftX;
			const ratio = range === 0 ? 0 : (progress - leftX) / range;

			return leftY + (rightY - leftY) * ratio;
		}
	}

	return points[points.length - 1][1];
}

function buildEtfCategoryLookup(categoryMap) {
	if (!categoryMap || typeof categoryMap !== 'object' || Array.isArray(categoryMap)) {
		return {};
	}

	return Object.entries(categoryMap).reduce((lookup, [categoryName, symbols]) => {
		if (!Array.isArray(symbols)) {
			return lookup;
		}

		for (const rawSymbol of symbols) {
			const normalizedSymbol = normalizeSymbol(rawSymbol);

			if (normalizedSymbol) {
				lookup[normalizedSymbol] = categoryName;
			}
		}

		return lookup;
	}, {});
}

function buildEtfCategoryBenchmarkSymbols(categoryMap) {
	if (!categoryMap || typeof categoryMap !== 'object' || Array.isArray(categoryMap)) {
		return {};
	}

	return Object.entries(categoryMap).reduce((benchmarkSymbols, [categoryName, symbols]) => {
		if (!Array.isArray(symbols) || symbols.length === 0) {
			return benchmarkSymbols;
		}

		const benchmarkSymbol = normalizeSymbol(symbols[0]);

		if (benchmarkSymbol) {
			benchmarkSymbols[categoryName] = benchmarkSymbol;
		}

		return benchmarkSymbols;
	}, {});
}

function buildSpecialEtfBehaviorLookup(specialBehaviorMap) {
	if (!specialBehaviorMap || typeof specialBehaviorMap !== 'object' || Array.isArray(specialBehaviorMap)) {
		return {};
	}

	return Object.entries(specialBehaviorMap).reduce((lookup, [rawSymbol, behaviorConfig]) => {
		const normalizedSymbol = normalizeSymbol(rawSymbol);
		const normalizedBehavior = normalizeSpecialEtfBehavior(behaviorConfig);

		if (normalizedSymbol && normalizedBehavior) {
			lookup[normalizedSymbol] = normalizedBehavior;
		}

		return lookup;
	}, {});
}

function normalizeSpecialEtfBehavior(behaviorConfig) {
	if (!behaviorConfig || typeof behaviorConfig !== 'object' || Array.isArray(behaviorConfig)) {
		return null;
	}

	const bucket =
		typeof behaviorConfig.bucket === 'string' && behaviorConfig.bucket.trim()
			? behaviorConfig.bucket.trim().toLowerCase()
			: null;
	const leverage =
		typeof behaviorConfig.leverage === 'number' && Number.isFinite(behaviorConfig.leverage) && behaviorConfig.leverage > 0
			? behaviorConfig.leverage
			: null;
	const direction = normalizeSpecialEtfDirection(behaviorConfig.direction);
	const underlyingSymbol = normalizeSymbol(behaviorConfig.underlyingSymbol);

	if (!bucket || leverage === null || !direction) {
		return null;
	}

	return {
		bucket,
		leverage,
		direction,
		underlyingSymbol
	};
}

function normalizeSpecialEtfDirection(direction) {
	if (typeof direction !== 'string') {
		return null;
	}

	const normalizedDirection = direction.trim().toLowerCase();

	if (normalizedDirection !== 'long' && normalizedDirection !== 'inverse') {
		return null;
	}

	return normalizedDirection;
}

function getSpecialEtfBehavior(symbol) {
	return specialEtfBehaviorLookup[symbol] || null;
}

function getSpecialEtfShockMultiplier(specialEtfBehavior) {
	if (!specialEtfBehavior || typeof specialEtfBehavior !== 'object') {
		return 1;
	}

	const directionMultiplier = specialEtfBehavior.direction === 'inverse' ? -1 : 1;

	return specialEtfBehavior.leverage * directionMultiplier;
}

function usesUnderlyingBasedSpecialEtfBehavior(specialEtfBehavior) {
	return Boolean(
		specialEtfBehavior &&
		typeof specialEtfBehavior === 'object' &&
		typeof specialEtfBehavior.underlyingSymbol === 'string' &&
		specialEtfBehavior.underlyingSymbol
	);
}

function clampNumber(value, minimumValue, maximumValue) {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return minimumValue;
	}

	return Math.min(Math.max(value, minimumValue), maximumValue);
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
