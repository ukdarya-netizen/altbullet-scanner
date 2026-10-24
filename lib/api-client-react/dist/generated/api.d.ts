import type { QueryKey, UseMutationOptions, UseMutationResult, UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import type { ActionResult, AltBulletIndicatorAnalysisResponse, BootstrapErrorReport, BotHealthStatus, BreakoutAnalysisDetail, BreakoutAnalysisList, BreakoutReplay, BtcAnalysisResponse, BtcCrossAlertsResponse, ClientErrorAccepted, ClientErrorReport, DailyStatsData, ErrorResponse, GetAdminTrackerIndicatorTargetObservationsParams, GetAdminTrackerReentryShadowParams, GetAltBulletIndicatorAnalysisParams, GetBreakoutReplayParams, GetGrowthLeadersParams, GetLiqCascadeParams, GetOverheatLogParams, GetScannerInspectParams, GetScannerSymbolHistoryParams, GetScannerSymbolIndicatorHistoryParams, GetScannerSymbolStatusHistoryParams, GetSignalHistoryParams, GetSignalsParams, GetTaScannerParams, GetTrackerDailyStatsParams, GetTrackerJournalParams, GetTradingPositionSyncParams, GetTrailingAnalysisParams, GrowthLeadersResponse, HealthStatus, IndicatorTargetObservationReport, InflowOutflowResponse, InspectResult, JournalStats, LcRapidReboundReport, LcRepeatWatchReport, LcWaitingShadowReport, LiqCascadeResponse, MemberSymbolStatusHistory, MonthlyStatsData, OverheatLogResponse, ReentryShadowAnalytics, ScanResult, ScannerCandidates, ScannerStatus, Settings, Signal, SignalHistoryResponse, SignalList, SignalsSummary, SubscriberList, SubscriberStats, SuccessResponse, SymbolHistory, SymbolIndicatorHistory, TaScannerResponse, TelegramWebhook200, TelegramWebhookBody, TradingPositionSync, TrailingAnalysisResponse, UpdateSettingsBody, WhaleAlertPoolResponse } from './api.schemas';
import { customFetch } from '../custom-fetch';
import type { ErrorType, BodyType } from '../custom-fetch';
type AwaitedInput<T> = PromiseLike<T> | T;
type Awaited<O> = O extends AwaitedInput<infer T> ? T : never;
type SecondParameter<T extends (...args: never) => unknown> = Parameters<T>[1];
export declare const getGetTradingPositionSyncUrl: (params?: GetTradingPositionSyncParams) => string;
/**
 * Machine-only, read-only. A delivered signal proves that the receiver enqueued it, not that it opened or closed a trade. All prices, stops, and PnL in this response belong to Bullet's tracker; the receiver must reconcile its own fills and quotes independently. Follow nextAfterId until null to collect the whole snapshot. Missing sourceStatus means the tracked row is unavailable and must not be treated as a close.
 * @summary Read Bullet state for signals accepted by the trading receiver
 */
export declare const getTradingPositionSync: (params?: GetTradingPositionSyncParams, options?: RequestInit) => Promise<TradingPositionSync>;
export declare const getGetTradingPositionSyncQueryKey: (params?: GetTradingPositionSyncParams) => readonly ["/api/trading/position-sync", ...GetTradingPositionSyncParams[]];
export declare const getGetTradingPositionSyncQueryOptions: <TData = Awaited<ReturnType<typeof getTradingPositionSync>>, TError = ErrorType<void>>(params?: GetTradingPositionSyncParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTradingPositionSync>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getTradingPositionSync>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetTradingPositionSyncQueryResult = NonNullable<Awaited<ReturnType<typeof getTradingPositionSync>>>;
export type GetTradingPositionSyncQueryError = ErrorType<void>;
/**
 * @summary Read Bullet state for signals accepted by the trading receiver
 */
export declare function useGetTradingPositionSync<TData = Awaited<ReturnType<typeof getTradingPositionSync>>, TError = ErrorType<void>>(params?: GetTradingPositionSyncParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTradingPositionSync>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetLcWaitingShadowUrl: () => string;
/**
 * @summary Read-only LC waiting-zone shadow observations
 */
export declare const getLcWaitingShadow: (options?: RequestInit) => Promise<LcWaitingShadowReport>;
export declare const getGetLcWaitingShadowQueryKey: () => readonly ["/api/admin/tracker/lc-waiting-shadow"];
export declare const getGetLcWaitingShadowQueryOptions: <TData = Awaited<ReturnType<typeof getLcWaitingShadow>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getLcWaitingShadow>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getLcWaitingShadow>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetLcWaitingShadowQueryResult = NonNullable<Awaited<ReturnType<typeof getLcWaitingShadow>>>;
export type GetLcWaitingShadowQueryError = ErrorType<void>;
/**
 * @summary Read-only LC waiting-zone shadow observations
 */
export declare function useGetLcWaitingShadow<TData = Awaited<ReturnType<typeof getLcWaitingShadow>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getLcWaitingShadow>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetLcRepeatWatchUrl: () => string;
/**
 * Owner-only descriptive watch of symbols with repeated LC signals in the trailing 30 days. It uses persisted decision-time map captures only, never current heatmaps or inferred clusters, and does not alter trades, entries, exits, scanners, or signal decisions.
 * @summary Read-only repeated Liquidation Cascade signal history
 */
export declare const getLcRepeatWatch: (options?: RequestInit) => Promise<LcRepeatWatchReport>;
export declare const getGetLcRepeatWatchQueryKey: () => readonly ["/api/admin/tracker/lc-repeat-watch"];
export declare const getGetLcRepeatWatchQueryOptions: <TData = Awaited<ReturnType<typeof getLcRepeatWatch>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getLcRepeatWatch>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getLcRepeatWatch>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetLcRepeatWatchQueryResult = NonNullable<Awaited<ReturnType<typeof getLcRepeatWatch>>>;
export type GetLcRepeatWatchQueryError = ErrorType<void>;
/**
 * @summary Read-only repeated Liquidation Cascade signal history
 */
export declare function useGetLcRepeatWatch<TData = Awaited<ReturnType<typeof getLcRepeatWatch>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getLcRepeatWatch>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetLcRapidReboundUrl: () => string;
/**
 * Admin-only, observation-only BingX perpetual candles and frozen liquidation-watch snapshots. Not a trading gate or causal claim.
 * @summary Observe fast 5m candle rebounds after LC liquidation watches
 */
export declare const getLcRapidRebound: (options?: RequestInit) => Promise<LcRapidReboundReport>;
export declare const getGetLcRapidReboundQueryKey: () => readonly ["/api/admin/tracker/lc-rapid-rebound"];
export declare const getGetLcRapidReboundQueryOptions: <TData = Awaited<ReturnType<typeof getLcRapidRebound>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getLcRapidRebound>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getLcRapidRebound>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetLcRapidReboundQueryResult = NonNullable<Awaited<ReturnType<typeof getLcRapidRebound>>>;
export type GetLcRapidReboundQueryError = ErrorType<void>;
/**
 * @summary Observe fast 5m candle rebounds after LC liquidation watches
 */
export declare function useGetLcRapidRebound<TData = Awaited<ReturnType<typeof getLcRapidRebound>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getLcRapidRebound>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetAdminTrackerReentryShadowUrl: (params?: GetAdminTrackerReentryShadowParams) => string;
/**
 * @summary Shadow-only re-entry telemetry
 */
export declare const getAdminTrackerReentryShadow: (params?: GetAdminTrackerReentryShadowParams, options?: RequestInit) => Promise<ReentryShadowAnalytics>;
export declare const getGetAdminTrackerReentryShadowQueryKey: (params?: GetAdminTrackerReentryShadowParams) => readonly ["/api/admin/tracker/reentry-shadow", ...GetAdminTrackerReentryShadowParams[]];
export declare const getGetAdminTrackerReentryShadowQueryOptions: <TData = Awaited<ReturnType<typeof getAdminTrackerReentryShadow>>, TError = ErrorType<void>>(params?: GetAdminTrackerReentryShadowParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAdminTrackerReentryShadow>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getAdminTrackerReentryShadow>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetAdminTrackerReentryShadowQueryResult = NonNullable<Awaited<ReturnType<typeof getAdminTrackerReentryShadow>>>;
export type GetAdminTrackerReentryShadowQueryError = ErrorType<void>;
/**
 * @summary Shadow-only re-entry telemetry
 */
export declare function useGetAdminTrackerReentryShadow<TData = Awaited<ReturnType<typeof getAdminTrackerReentryShadow>>, TError = ErrorType<void>>(params?: GetAdminTrackerReentryShadowParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAdminTrackerReentryShadow>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetAdminTrackerIndicatorTargetObservationsUrl: (params?: GetAdminTrackerIndicatorTargetObservationsParams) => string;
/**
 * Read-only monitoring for the +8%, +12%, and +16% observational target hypotheses. Reports durable experiment enrollment, target and follow-up states, exact complete 72h outcomes, entry indicator provenance, durable database freshness, process-local worker health, and bounded recent rows. This is observation-only and must not be used as a take-profit recommendation.
 * @summary Owner-only indicator-target observation experiment monitoring
 */
export declare const getAdminTrackerIndicatorTargetObservations: (params?: GetAdminTrackerIndicatorTargetObservationsParams, options?: RequestInit) => Promise<IndicatorTargetObservationReport>;
export declare const getGetAdminTrackerIndicatorTargetObservationsQueryKey: (params?: GetAdminTrackerIndicatorTargetObservationsParams) => readonly ["/api/admin/tracker/indicator-target-observations", ...GetAdminTrackerIndicatorTargetObservationsParams[]];
export declare const getGetAdminTrackerIndicatorTargetObservationsQueryOptions: <TData = Awaited<ReturnType<typeof getAdminTrackerIndicatorTargetObservations>>, TError = ErrorType<void>>(params?: GetAdminTrackerIndicatorTargetObservationsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAdminTrackerIndicatorTargetObservations>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getAdminTrackerIndicatorTargetObservations>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetAdminTrackerIndicatorTargetObservationsQueryResult = NonNullable<Awaited<ReturnType<typeof getAdminTrackerIndicatorTargetObservations>>>;
export type GetAdminTrackerIndicatorTargetObservationsQueryError = ErrorType<void>;
/**
 * @summary Owner-only indicator-target observation experiment monitoring
 */
export declare function useGetAdminTrackerIndicatorTargetObservations<TData = Awaited<ReturnType<typeof getAdminTrackerIndicatorTargetObservations>>, TError = ErrorType<void>>(params?: GetAdminTrackerIndicatorTargetObservationsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAdminTrackerIndicatorTargetObservations>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getReportBootstrapErrorUrl: () => string;
/**
 * @summary Report an anonymous sanitized dashboard bootstrap failure
 */
export declare const reportBootstrapError: (bootstrapErrorReport: BootstrapErrorReport, options?: RequestInit) => Promise<ClientErrorAccepted>;
export declare const getReportBootstrapErrorMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof reportBootstrapError>>, TError, {
        data: BodyType<BootstrapErrorReport>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof reportBootstrapError>>, TError, {
    data: BodyType<BootstrapErrorReport>;
}, TContext>;
export type ReportBootstrapErrorMutationResult = NonNullable<Awaited<ReturnType<typeof reportBootstrapError>>>;
export type ReportBootstrapErrorMutationBody = BodyType<BootstrapErrorReport>;
export type ReportBootstrapErrorMutationError = ErrorType<ErrorResponse>;
/**
* @summary Report an anonymous sanitized dashboard bootstrap failure
*/
export declare const useReportBootstrapError: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof reportBootstrapError>>, TError, {
        data: BodyType<BootstrapErrorReport>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof reportBootstrapError>>, TError, {
    data: BodyType<BootstrapErrorReport>;
}, TContext>;
export declare const getReportClientErrorUrl: () => string;
/**
 * @summary Report a sanitized authenticated dashboard error
 */
export declare const reportClientError: (clientErrorReport: ClientErrorReport, options?: RequestInit) => Promise<ClientErrorAccepted>;
export declare const getReportClientErrorMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof reportClientError>>, TError, {
        data: BodyType<ClientErrorReport>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof reportClientError>>, TError, {
    data: BodyType<ClientErrorReport>;
}, TContext>;
export type ReportClientErrorMutationResult = NonNullable<Awaited<ReturnType<typeof reportClientError>>>;
export type ReportClientErrorMutationBody = BodyType<ClientErrorReport>;
export type ReportClientErrorMutationError = ErrorType<ErrorResponse>;
/**
* @summary Report a sanitized authenticated dashboard error
*/
export declare const useReportClientError: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof reportClientError>>, TError, {
        data: BodyType<ClientErrorReport>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof reportClientError>>, TError, {
    data: BodyType<ClientErrorReport>;
}, TContext>;
export declare const getHealthCheckUrl: () => string;
/**
 * Returns server health status
 * @summary Health check
 */
export declare const healthCheck: (options?: RequestInit) => Promise<HealthStatus>;
export declare const getHealthCheckQueryKey: () => readonly ["/api/healthz"];
export declare const getHealthCheckQueryOptions: <TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData> & {
    queryKey: QueryKey;
};
export type HealthCheckQueryResult = NonNullable<Awaited<ReturnType<typeof healthCheck>>>;
export type HealthCheckQueryError = ErrorType<unknown>;
/**
 * @summary Health check
 */
export declare function useHealthCheck<TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetScannerStatusUrl: () => string;
/**
 * Returns current scanner status and stats
 * @summary Get scanner status
 */
export declare const getScannerStatus: (options?: RequestInit) => Promise<ScannerStatus>;
export declare const getGetScannerStatusQueryKey: () => readonly ["/api/scanner/status"];
export declare const getGetScannerStatusQueryOptions: <TData = Awaited<ReturnType<typeof getScannerStatus>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerStatus>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getScannerStatus>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetScannerStatusQueryResult = NonNullable<Awaited<ReturnType<typeof getScannerStatus>>>;
export type GetScannerStatusQueryError = ErrorType<unknown>;
/**
 * @summary Get scanner status
 */
export declare function useGetScannerStatus<TData = Awaited<ReturnType<typeof getScannerStatus>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerStatus>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getStartScannerUrl: () => string;
/**
 * Start the alpha signal scanner
 * @summary Start scanner
 */
export declare const startScanner: (options?: RequestInit) => Promise<ActionResult>;
export declare const getStartScannerMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof startScanner>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof startScanner>>, TError, void, TContext>;
export type StartScannerMutationResult = NonNullable<Awaited<ReturnType<typeof startScanner>>>;
export type StartScannerMutationError = ErrorType<unknown>;
/**
* @summary Start scanner
*/
export declare const useStartScanner: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof startScanner>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof startScanner>>, TError, void, TContext>;
export declare const getStopScannerUrl: () => string;
/**
 * Stop the alpha signal scanner
 * @summary Stop scanner
 */
export declare const stopScanner: (options?: RequestInit) => Promise<ActionResult>;
export declare const getStopScannerMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof stopScanner>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof stopScanner>>, TError, void, TContext>;
export type StopScannerMutationResult = NonNullable<Awaited<ReturnType<typeof stopScanner>>>;
export type StopScannerMutationError = ErrorType<unknown>;
/**
* @summary Stop scanner
*/
export declare const useStopScanner: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof stopScanner>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof stopScanner>>, TError, void, TContext>;
export declare const getGetScannerCandidatesUrl: () => string;
/**
 * Returns current prescan hot list and OI watch queue
 * @summary Get scanner candidates
 */
export declare const getScannerCandidates: (options?: RequestInit) => Promise<ScannerCandidates>;
export declare const getGetScannerCandidatesQueryKey: () => readonly ["/api/scanner/candidates"];
export declare const getGetScannerCandidatesQueryOptions: <TData = Awaited<ReturnType<typeof getScannerCandidates>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerCandidates>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getScannerCandidates>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetScannerCandidatesQueryResult = NonNullable<Awaited<ReturnType<typeof getScannerCandidates>>>;
export type GetScannerCandidatesQueryError = ErrorType<unknown>;
/**
 * @summary Get scanner candidates
 */
export declare function useGetScannerCandidates<TData = Awaited<ReturnType<typeof getScannerCandidates>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerCandidates>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetBreakoutAnalysisUrl: () => string;
/**
 * Dashboard-member 4H structure analysis over closed BingX candles. It does not change signal firing conditions.
 * @summary Analyze technical breakouts for current candidates
 */
export declare const getBreakoutAnalysis: (options?: RequestInit) => Promise<BreakoutAnalysisList>;
export declare const getGetBreakoutAnalysisQueryKey: () => readonly ["/api/scanner/breakout-analysis"];
export declare const getGetBreakoutAnalysisQueryOptions: <TData = Awaited<ReturnType<typeof getBreakoutAnalysis>>, TError = ErrorType<ErrorResponse>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBreakoutAnalysis>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBreakoutAnalysis>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBreakoutAnalysisQueryResult = NonNullable<Awaited<ReturnType<typeof getBreakoutAnalysis>>>;
export type GetBreakoutAnalysisQueryError = ErrorType<ErrorResponse>;
/**
 * @summary Analyze technical breakouts for current candidates
 */
export declare function useGetBreakoutAnalysis<TData = Awaited<ReturnType<typeof getBreakoutAnalysis>>, TError = ErrorType<ErrorResponse>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBreakoutAnalysis>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetBreakoutAnalysisDetailUrl: (symbol: string) => string;
/**
 * Dashboard-member chart-ready view of the live Stealth Breakout sequence: frozen 4H resistance, closed 4H breakout, and 30m entry refinement; 1H is optional context only.
 * @summary Get technical breakout chart data for a symbol
 */
export declare const getBreakoutAnalysisDetail: (symbol: string, options?: RequestInit) => Promise<BreakoutAnalysisDetail>;
export declare const getGetBreakoutAnalysisDetailQueryKey: (symbol: string) => readonly [`/api/scanner/breakout-analysis/${string}`];
export declare const getGetBreakoutAnalysisDetailQueryOptions: <TData = Awaited<ReturnType<typeof getBreakoutAnalysisDetail>>, TError = ErrorType<ErrorResponse>>(symbol: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBreakoutAnalysisDetail>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBreakoutAnalysisDetail>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBreakoutAnalysisDetailQueryResult = NonNullable<Awaited<ReturnType<typeof getBreakoutAnalysisDetail>>>;
export type GetBreakoutAnalysisDetailQueryError = ErrorType<ErrorResponse>;
/**
 * @summary Get technical breakout chart data for a symbol
 */
export declare function useGetBreakoutAnalysisDetail<TData = Awaited<ReturnType<typeof getBreakoutAnalysisDetail>>, TError = ErrorType<ErrorResponse>>(symbol: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBreakoutAnalysisDetail>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetBreakoutReplayUrl: (params: GetBreakoutReplayParams) => string;
/**
 * Dashboard-member replay over closed BingX OHLCV candles. Each event is evaluated at a closed 4H candle crossing frozen resistance with 30m entry refinement; 1H is optional context only, future returns are reported separately, and historical flow gates are explicitly unavailable.
 * @summary Replay historical Stealth Breakout events
 */
export declare const getBreakoutReplay: (params: GetBreakoutReplayParams, options?: RequestInit) => Promise<BreakoutReplay>;
export declare const getGetBreakoutReplayQueryKey: (params?: GetBreakoutReplayParams) => readonly ["/api/scanner/breakout-replay", ...GetBreakoutReplayParams[]];
export declare const getGetBreakoutReplayQueryOptions: <TData = Awaited<ReturnType<typeof getBreakoutReplay>>, TError = ErrorType<ErrorResponse>>(params: GetBreakoutReplayParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBreakoutReplay>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBreakoutReplay>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBreakoutReplayQueryResult = NonNullable<Awaited<ReturnType<typeof getBreakoutReplay>>>;
export type GetBreakoutReplayQueryError = ErrorType<ErrorResponse>;
/**
 * @summary Replay historical Stealth Breakout events
 */
export declare function useGetBreakoutReplay<TData = Awaited<ReturnType<typeof getBreakoutReplay>>, TError = ErrorType<ErrorResponse>>(params: GetBreakoutReplayParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBreakoutReplay>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetScannerSymbolHistoryUrl: (params: GetScannerSymbolHistoryParams) => string;
/**
 * Returns prescan cycle history and OI Watch entry history for a given symbol
 * @summary Get symbol history
 */
export declare const getScannerSymbolHistory: (params: GetScannerSymbolHistoryParams, options?: RequestInit) => Promise<SymbolHistory>;
export declare const getGetScannerSymbolHistoryQueryKey: (params?: GetScannerSymbolHistoryParams) => readonly ["/api/scanner/symbol-history", ...GetScannerSymbolHistoryParams[]];
export declare const getGetScannerSymbolHistoryQueryOptions: <TData = Awaited<ReturnType<typeof getScannerSymbolHistory>>, TError = ErrorType<unknown>>(params: GetScannerSymbolHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerSymbolHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getScannerSymbolHistory>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetScannerSymbolHistoryQueryResult = NonNullable<Awaited<ReturnType<typeof getScannerSymbolHistory>>>;
export type GetScannerSymbolHistoryQueryError = ErrorType<unknown>;
/**
 * @summary Get symbol history
 */
export declare function useGetScannerSymbolHistory<TData = Awaited<ReturnType<typeof getScannerSymbolHistory>>, TError = ErrorType<unknown>>(params: GetScannerSymbolHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerSymbolHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetScannerSymbolStatusHistoryUrl: (params: GetScannerSymbolStatusHistoryParams) => string;
/**
 * @summary Get member-safe per-symbol scanner status history
 */
export declare const getScannerSymbolStatusHistory: (params: GetScannerSymbolStatusHistoryParams, options?: RequestInit) => Promise<MemberSymbolStatusHistory>;
export declare const getGetScannerSymbolStatusHistoryQueryKey: (params?: GetScannerSymbolStatusHistoryParams) => readonly ["/api/scanner/symbol-status-history", ...GetScannerSymbolStatusHistoryParams[]];
export declare const getGetScannerSymbolStatusHistoryQueryOptions: <TData = Awaited<ReturnType<typeof getScannerSymbolStatusHistory>>, TError = ErrorType<unknown>>(params: GetScannerSymbolStatusHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerSymbolStatusHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getScannerSymbolStatusHistory>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetScannerSymbolStatusHistoryQueryResult = NonNullable<Awaited<ReturnType<typeof getScannerSymbolStatusHistory>>>;
export type GetScannerSymbolStatusHistoryQueryError = ErrorType<unknown>;
/**
 * @summary Get member-safe per-symbol scanner status history
 */
export declare function useGetScannerSymbolStatusHistory<TData = Awaited<ReturnType<typeof getScannerSymbolStatusHistory>>, TError = ErrorType<unknown>>(params: GetScannerSymbolStatusHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerSymbolStatusHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetScannerSymbolIndicatorHistoryUrl: (params: GetScannerSymbolIndicatorHistoryParams) => string;
/**
 * Member-only prescan observations from the rolling 14-day archive and signal-time RSI/Williams readings. Missing samples are not reconstructed.
 * @summary Recorded indicator readings for the in-app token chart
 */
export declare const getScannerSymbolIndicatorHistory: (params: GetScannerSymbolIndicatorHistoryParams, options?: RequestInit) => Promise<SymbolIndicatorHistory>;
export declare const getGetScannerSymbolIndicatorHistoryQueryKey: (params?: GetScannerSymbolIndicatorHistoryParams) => readonly ["/api/scanner/symbol-indicator-history", ...GetScannerSymbolIndicatorHistoryParams[]];
export declare const getGetScannerSymbolIndicatorHistoryQueryOptions: <TData = Awaited<ReturnType<typeof getScannerSymbolIndicatorHistory>>, TError = ErrorType<ErrorResponse>>(params: GetScannerSymbolIndicatorHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerSymbolIndicatorHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getScannerSymbolIndicatorHistory>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetScannerSymbolIndicatorHistoryQueryResult = NonNullable<Awaited<ReturnType<typeof getScannerSymbolIndicatorHistory>>>;
export type GetScannerSymbolIndicatorHistoryQueryError = ErrorType<ErrorResponse>;
/**
 * @summary Recorded indicator readings for the in-app token chart
 */
export declare function useGetScannerSymbolIndicatorHistory<TData = Awaited<ReturnType<typeof getScannerSymbolIndicatorHistory>>, TError = ErrorType<ErrorResponse>>(params: GetScannerSymbolIndicatorHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerSymbolIndicatorHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetScannerInspectUrl: (params: GetScannerInspectParams) => string;
/**
 * Returns a live metrics snapshot (OI/CVD/volMult/taker + active OI Watch + active tracked signal) for a comma-separated list of symbols. Used by the manual инспектор widget.
 * @summary Inspect symbols
 */
export declare const getScannerInspect: (params: GetScannerInspectParams, options?: RequestInit) => Promise<InspectResult>;
export declare const getGetScannerInspectQueryKey: (params?: GetScannerInspectParams) => readonly ["/api/scanner/inspect", ...GetScannerInspectParams[]];
export declare const getGetScannerInspectQueryOptions: <TData = Awaited<ReturnType<typeof getScannerInspect>>, TError = ErrorType<unknown>>(params: GetScannerInspectParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerInspect>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getScannerInspect>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetScannerInspectQueryResult = NonNullable<Awaited<ReturnType<typeof getScannerInspect>>>;
export type GetScannerInspectQueryError = ErrorType<unknown>;
/**
 * @summary Inspect symbols
 */
export declare function useGetScannerInspect<TData = Awaited<ReturnType<typeof getScannerInspect>>, TError = ErrorType<unknown>>(params: GetScannerInspectParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerInspect>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getScanNowUrl: () => string;
/**
 * Trigger an immediate scan of all markets
 * @summary Trigger manual scan
 */
export declare const scanNow: (options?: RequestInit) => Promise<ScanResult>;
export declare const getScanNowMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof scanNow>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof scanNow>>, TError, void, TContext>;
export type ScanNowMutationResult = NonNullable<Awaited<ReturnType<typeof scanNow>>>;
export type ScanNowMutationError = ErrorType<unknown>;
/**
* @summary Trigger manual scan
*/
export declare const useScanNow: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof scanNow>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof scanNow>>, TError, void, TContext>;
export declare const getGetSignalsUrl: (params?: GetSignalsParams) => string;
/**
 * Returns list of detected alpha signals
 * @summary Get signals
 */
export declare const getSignals: (params?: GetSignalsParams, options?: RequestInit) => Promise<SignalList>;
export declare const getGetSignalsQueryKey: (params?: GetSignalsParams) => readonly ["/api/signals", ...GetSignalsParams[]];
export declare const getGetSignalsQueryOptions: <TData = Awaited<ReturnType<typeof getSignals>>, TError = ErrorType<unknown>>(params?: GetSignalsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSignals>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getSignals>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetSignalsQueryResult = NonNullable<Awaited<ReturnType<typeof getSignals>>>;
export type GetSignalsQueryError = ErrorType<unknown>;
/**
 * @summary Get signals
 */
export declare function useGetSignals<TData = Awaited<ReturnType<typeof getSignals>>, TError = ErrorType<unknown>>(params?: GetSignalsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSignals>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetSignalsSummaryUrl: () => string;
/**
 * Returns aggregated statistics about detected signals
 * @summary Get signals summary
 */
export declare const getSignalsSummary: (options?: RequestInit) => Promise<SignalsSummary>;
export declare const getGetSignalsSummaryQueryKey: () => readonly ["/api/signals/summary"];
export declare const getGetSignalsSummaryQueryOptions: <TData = Awaited<ReturnType<typeof getSignalsSummary>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSignalsSummary>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getSignalsSummary>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetSignalsSummaryQueryResult = NonNullable<Awaited<ReturnType<typeof getSignalsSummary>>>;
export type GetSignalsSummaryQueryError = ErrorType<unknown>;
/**
 * @summary Get signals summary
 */
export declare function useGetSignalsSummary<TData = Awaited<ReturnType<typeof getSignalsSummary>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSignalsSummary>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetSignalUrl: (id: number) => string;
/**
 * @summary Get signal by ID
 */
export declare const getSignal: (id: number, options?: RequestInit) => Promise<Signal>;
export declare const getGetSignalQueryKey: (id: number) => readonly [`/api/signals/${number}`];
export declare const getGetSignalQueryOptions: <TData = Awaited<ReturnType<typeof getSignal>>, TError = ErrorType<ErrorResponse>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSignal>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getSignal>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetSignalQueryResult = NonNullable<Awaited<ReturnType<typeof getSignal>>>;
export type GetSignalQueryError = ErrorType<ErrorResponse>;
/**
 * @summary Get signal by ID
 */
export declare function useGetSignal<TData = Awaited<ReturnType<typeof getSignal>>, TError = ErrorType<ErrorResponse>>(id: number, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSignal>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetSettingsUrl: () => string;
/**
 * Returns current scanner configuration
 * @summary Get scanner settings
 */
export declare const getSettings: (options?: RequestInit) => Promise<Settings>;
export declare const getGetSettingsQueryKey: () => readonly ["/api/settings"];
export declare const getGetSettingsQueryOptions: <TData = Awaited<ReturnType<typeof getSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getSettings>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetSettingsQueryResult = NonNullable<Awaited<ReturnType<typeof getSettings>>>;
export type GetSettingsQueryError = ErrorType<unknown>;
/**
 * @summary Get scanner settings
 */
export declare function useGetSettings<TData = Awaited<ReturnType<typeof getSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getUpdateSettingsUrl: () => string;
/**
 * Update scanner configuration parameters
 * @summary Update scanner settings
 */
export declare const updateSettings: (updateSettingsBody: UpdateSettingsBody, options?: RequestInit) => Promise<Settings>;
export declare const getUpdateSettingsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateSettings>>, TError, {
        data: BodyType<UpdateSettingsBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateSettings>>, TError, {
    data: BodyType<UpdateSettingsBody>;
}, TContext>;
export type UpdateSettingsMutationResult = NonNullable<Awaited<ReturnType<typeof updateSettings>>>;
export type UpdateSettingsMutationBody = BodyType<UpdateSettingsBody>;
export type UpdateSettingsMutationError = ErrorType<unknown>;
/**
* @summary Update scanner settings
*/
export declare const useUpdateSettings: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateSettings>>, TError, {
        data: BodyType<UpdateSettingsBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateSettings>>, TError, {
    data: BodyType<UpdateSettingsBody>;
}, TContext>;
export declare const getGetSubscribersUrl: () => string;
/**
 * Returns list of Telegram bot subscribers
 * @summary Get subscribers list
 */
export declare const getSubscribers: (options?: RequestInit) => Promise<SubscriberList>;
export declare const getGetSubscribersQueryKey: () => readonly ["/api/subscribers"];
export declare const getGetSubscribersQueryOptions: <TData = Awaited<ReturnType<typeof getSubscribers>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSubscribers>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getSubscribers>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetSubscribersQueryResult = NonNullable<Awaited<ReturnType<typeof getSubscribers>>>;
export type GetSubscribersQueryError = ErrorType<unknown>;
/**
 * @summary Get subscribers list
 */
export declare function useGetSubscribers<TData = Awaited<ReturnType<typeof getSubscribers>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSubscribers>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetTrackerJournalUrl: (params?: GetTrackerJournalParams) => string;
/**
 * Returns aggregated performance stats, per-pattern breakdown, and recent closed trades
 * @summary Get trading journal data
 */
export declare const getTrackerJournal: (params?: GetTrackerJournalParams, options?: RequestInit) => Promise<JournalStats>;
export declare const getGetTrackerJournalQueryKey: (params?: GetTrackerJournalParams) => readonly ["/api/tracker/journal", ...GetTrackerJournalParams[]];
export declare const getGetTrackerJournalQueryOptions: <TData = Awaited<ReturnType<typeof getTrackerJournal>>, TError = ErrorType<unknown>>(params?: GetTrackerJournalParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrackerJournal>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getTrackerJournal>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetTrackerJournalQueryResult = NonNullable<Awaited<ReturnType<typeof getTrackerJournal>>>;
export type GetTrackerJournalQueryError = ErrorType<unknown>;
/**
 * @summary Get trading journal data
 */
export declare function useGetTrackerJournal<TData = Awaited<ReturnType<typeof getTrackerJournal>>, TError = ErrorType<unknown>>(params?: GetTrackerJournalParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrackerJournal>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetSignalHistoryUrl: (params?: GetSignalHistoryParams) => string;
/**
 * Returns paginated active and closed tracked signals with entry, exit, and observed drawdown audit data.
 * @summary Get full tracked signal history
 */
export declare const getSignalHistory: (params?: GetSignalHistoryParams, options?: RequestInit) => Promise<SignalHistoryResponse>;
export declare const getGetSignalHistoryQueryKey: (params?: GetSignalHistoryParams) => readonly ["/api/tracker/signal-history", ...GetSignalHistoryParams[]];
export declare const getGetSignalHistoryQueryOptions: <TData = Awaited<ReturnType<typeof getSignalHistory>>, TError = ErrorType<unknown>>(params?: GetSignalHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSignalHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getSignalHistory>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetSignalHistoryQueryResult = NonNullable<Awaited<ReturnType<typeof getSignalHistory>>>;
export type GetSignalHistoryQueryError = ErrorType<unknown>;
/**
 * @summary Get full tracked signal history
 */
export declare function useGetSignalHistory<TData = Awaited<ReturnType<typeof getSignalHistory>>, TError = ErrorType<unknown>>(params?: GetSignalHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSignalHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetAltBulletIndicatorAnalysisUrl: (params?: GetAltBulletIndicatorAnalysisParams) => string;
/**
 * Defaults to altbullet-neon-v7-observational. Cohorts are never mixed; availableVersions lists immutable historical cohorts.
 * @summary Analyze versioned observational AltBullet snapshots
 */
export declare const getAltBulletIndicatorAnalysis: (params?: GetAltBulletIndicatorAnalysisParams, options?: RequestInit) => Promise<AltBulletIndicatorAnalysisResponse>;
export declare const getGetAltBulletIndicatorAnalysisQueryKey: (params?: GetAltBulletIndicatorAnalysisParams) => readonly ["/api/tracker/altbullet-indicator-analysis", ...GetAltBulletIndicatorAnalysisParams[]];
export declare const getGetAltBulletIndicatorAnalysisQueryOptions: <TData = Awaited<ReturnType<typeof getAltBulletIndicatorAnalysis>>, TError = ErrorType<unknown>>(params?: GetAltBulletIndicatorAnalysisParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAltBulletIndicatorAnalysis>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getAltBulletIndicatorAnalysis>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetAltBulletIndicatorAnalysisQueryResult = NonNullable<Awaited<ReturnType<typeof getAltBulletIndicatorAnalysis>>>;
export type GetAltBulletIndicatorAnalysisQueryError = ErrorType<unknown>;
/**
 * @summary Analyze versioned observational AltBullet snapshots
 */
export declare function useGetAltBulletIndicatorAnalysis<TData = Awaited<ReturnType<typeof getAltBulletIndicatorAnalysis>>, TError = ErrorType<unknown>>(params?: GetAltBulletIndicatorAnalysisParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAltBulletIndicatorAnalysis>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetTrailingAnalysisUrl: (params?: GetTrailingAnalysisParams) => string;
/**
 * Returns observation-only trailing replay profiles and candidate comparisons by pattern. These replays and comparisons never alter real exits or signal gates; the live impulse_runner_v1 policy applies only to newly policy-stamped positions.
 * @summary Compare observational trailing replays and candidate policies
 */
export declare const getTrailingAnalysis: (params?: GetTrailingAnalysisParams, options?: RequestInit) => Promise<TrailingAnalysisResponse>;
export declare const getGetTrailingAnalysisQueryKey: (params?: GetTrailingAnalysisParams) => readonly ["/api/tracker/trailing-analysis", ...GetTrailingAnalysisParams[]];
export declare const getGetTrailingAnalysisQueryOptions: <TData = Awaited<ReturnType<typeof getTrailingAnalysis>>, TError = ErrorType<unknown>>(params?: GetTrailingAnalysisParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrailingAnalysis>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getTrailingAnalysis>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetTrailingAnalysisQueryResult = NonNullable<Awaited<ReturnType<typeof getTrailingAnalysis>>>;
export type GetTrailingAnalysisQueryError = ErrorType<unknown>;
/**
 * @summary Compare observational trailing replays and candidate policies
 */
export declare function useGetTrailingAnalysis<TData = Awaited<ReturnType<typeof getTrailingAnalysis>>, TError = ErrorType<unknown>>(params?: GetTrailingAnalysisParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrailingAnalysis>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetTrackerMonthlyStatsUrl: () => string;
/**
 * Returns trading stats grouped by calendar month
 * @summary Get monthly performance stats
 */
export declare const getTrackerMonthlyStats: (options?: RequestInit) => Promise<MonthlyStatsData>;
export declare const getGetTrackerMonthlyStatsQueryKey: () => readonly ["/api/tracker/monthly-stats"];
export declare const getGetTrackerMonthlyStatsQueryOptions: <TData = Awaited<ReturnType<typeof getTrackerMonthlyStats>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrackerMonthlyStats>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getTrackerMonthlyStats>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetTrackerMonthlyStatsQueryResult = NonNullable<Awaited<ReturnType<typeof getTrackerMonthlyStats>>>;
export type GetTrackerMonthlyStatsQueryError = ErrorType<unknown>;
/**
 * @summary Get monthly performance stats
 */
export declare function useGetTrackerMonthlyStats<TData = Awaited<ReturnType<typeof getTrackerMonthlyStats>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrackerMonthlyStats>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetTrackerDailyStatsUrl: (params?: GetTrackerDailyStatsParams) => string;
/**
 * Returns trading stats grouped by calendar day in Asia/Dubai, using either signal entry or close date
 * @summary Get daily performance stats
 */
export declare const getTrackerDailyStats: (params?: GetTrackerDailyStatsParams, options?: RequestInit) => Promise<DailyStatsData>;
export declare const getGetTrackerDailyStatsQueryKey: (params?: GetTrackerDailyStatsParams) => readonly ["/api/tracker/daily-stats", ...GetTrackerDailyStatsParams[]];
export declare const getGetTrackerDailyStatsQueryOptions: <TData = Awaited<ReturnType<typeof getTrackerDailyStats>>, TError = ErrorType<unknown>>(params?: GetTrackerDailyStatsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrackerDailyStats>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getTrackerDailyStats>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetTrackerDailyStatsQueryResult = NonNullable<Awaited<ReturnType<typeof getTrackerDailyStats>>>;
export type GetTrackerDailyStatsQueryError = ErrorType<unknown>;
/**
 * @summary Get daily performance stats
 */
export declare function useGetTrackerDailyStats<TData = Awaited<ReturnType<typeof getTrackerDailyStats>>, TError = ErrorType<unknown>>(params?: GetTrackerDailyStatsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTrackerDailyStats>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetBtcAnalysisUrl: () => string;
/**
 * Returns descriptive BTC 24h context collected at entry and close for tracked alt signals, plus BTC positions. This endpoint is owner-only and does not change scanner gates or trading decisions.
 * @summary Get owner-only BTC context coverage and outcome analysis
 */
export declare const getBtcAnalysis: (options?: RequestInit) => Promise<BtcAnalysisResponse>;
export declare const getGetBtcAnalysisQueryKey: () => readonly ["/api/tracker/btc-analysis"];
export declare const getGetBtcAnalysisQueryOptions: <TData = Awaited<ReturnType<typeof getBtcAnalysis>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBtcAnalysis>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBtcAnalysis>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBtcAnalysisQueryResult = NonNullable<Awaited<ReturnType<typeof getBtcAnalysis>>>;
export type GetBtcAnalysisQueryError = ErrorType<void>;
/**
 * @summary Get owner-only BTC context coverage and outcome analysis
 */
export declare function useGetBtcAnalysis<TData = Awaited<ReturnType<typeof getBtcAnalysis>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBtcAnalysis>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetBtcCrossAlertsUrl: () => string;
/**
 * @summary Get owner BTC/dominance crossing alerts
 */
export declare const getBtcCrossAlerts: (options?: RequestInit) => Promise<BtcCrossAlertsResponse>;
export declare const getGetBtcCrossAlertsQueryKey: () => readonly ["/api/btc-cross-alerts"];
export declare const getGetBtcCrossAlertsQueryOptions: <TData = Awaited<ReturnType<typeof getBtcCrossAlerts>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBtcCrossAlerts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBtcCrossAlerts>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBtcCrossAlertsQueryResult = NonNullable<Awaited<ReturnType<typeof getBtcCrossAlerts>>>;
export type GetBtcCrossAlertsQueryError = ErrorType<void>;
/**
 * @summary Get owner BTC/dominance crossing alerts
 */
export declare function useGetBtcCrossAlerts<TData = Awaited<ReturnType<typeof getBtcCrossAlerts>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBtcCrossAlerts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getMarkBtcCrossAlertReadUrl: (id: number) => string;
/**
 * @summary Mark an owner BTC/dominance crossing alert as read
 */
export declare const markBtcCrossAlertRead: (id: number, options?: RequestInit) => Promise<SuccessResponse>;
export declare const getMarkBtcCrossAlertReadMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof markBtcCrossAlertRead>>, TError, {
        id: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof markBtcCrossAlertRead>>, TError, {
    id: number;
}, TContext>;
export type MarkBtcCrossAlertReadMutationResult = NonNullable<Awaited<ReturnType<typeof markBtcCrossAlertRead>>>;
export type MarkBtcCrossAlertReadMutationError = ErrorType<void>;
/**
* @summary Mark an owner BTC/dominance crossing alert as read
*/
export declare const useMarkBtcCrossAlertRead: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof markBtcCrossAlertRead>>, TError, {
        id: number;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof markBtcCrossAlertRead>>, TError, {
    id: number;
}, TContext>;
export declare const getGetSubscriberStatsUrl: () => string;
/**
 * Returns subscriber count and growth stats
 * @summary Get subscriber statistics
 */
export declare const getSubscriberStats: (options?: RequestInit) => Promise<SubscriberStats>;
export declare const getGetSubscriberStatsQueryKey: () => readonly ["/api/subscribers/stats"];
export declare const getGetSubscriberStatsQueryOptions: <TData = Awaited<ReturnType<typeof getSubscriberStats>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSubscriberStats>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getSubscriberStats>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetSubscriberStatsQueryResult = NonNullable<Awaited<ReturnType<typeof getSubscriberStats>>>;
export type GetSubscriberStatsQueryError = ErrorType<unknown>;
/**
 * @summary Get subscriber statistics
 */
export declare function useGetSubscriberStats<TData = Awaited<ReturnType<typeof getSubscriberStats>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSubscriberStats>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetScannerWhaleAlertsUrl: () => string;
/**
 * Returns active and recent Hyperliquid whale alert pool entries with per-cycle live metrics
 * @summary Whale Alert pool (Layer 11)
 */
export declare const getScannerWhaleAlerts: (options?: RequestInit) => Promise<WhaleAlertPoolResponse>;
export declare const getGetScannerWhaleAlertsQueryKey: () => readonly ["/api/scanner/whale-alerts"];
export declare const getGetScannerWhaleAlertsQueryOptions: <TData = Awaited<ReturnType<typeof getScannerWhaleAlerts>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerWhaleAlerts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getScannerWhaleAlerts>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetScannerWhaleAlertsQueryResult = NonNullable<Awaited<ReturnType<typeof getScannerWhaleAlerts>>>;
export type GetScannerWhaleAlertsQueryError = ErrorType<unknown>;
/**
 * @summary Whale Alert pool (Layer 11)
 */
export declare function useGetScannerWhaleAlerts<TData = Awaited<ReturnType<typeof getScannerWhaleAlerts>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerWhaleAlerts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetBotHealthUrl: () => string;
/**
 * Агрегированные индикаторы работоспособности — сканер, CoinGlass, фоновые джобы, БД
 * @summary Bot health dashboard
 */
export declare const getBotHealth: (options?: RequestInit) => Promise<BotHealthStatus>;
export declare const getGetBotHealthQueryKey: () => readonly ["/api/scanner/bot-health"];
export declare const getGetBotHealthQueryOptions: <TData = Awaited<ReturnType<typeof getBotHealth>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBotHealth>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBotHealth>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBotHealthQueryResult = NonNullable<Awaited<ReturnType<typeof getBotHealth>>>;
export type GetBotHealthQueryError = ErrorType<unknown>;
/**
 * @summary Bot health dashboard
 */
export declare function useGetBotHealth<TData = Awaited<ReturnType<typeof getBotHealth>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBotHealth>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetScannerInflowOutflowUrl: () => string;
/**
 * On-chain outflow кандидаты: токены с крупным оттоком с бирж (вывод ≥$2M = накопление умных денег). Данные: CoinGlass exchange/chain/tx/list + exchange_assets_transparency/list.
 * @summary Layer 14 — Exchange Inflow/Outflow pool
 */
export declare const getScannerInflowOutflow: (options?: RequestInit) => Promise<InflowOutflowResponse>;
export declare const getGetScannerInflowOutflowQueryKey: () => readonly ["/api/scanner/inflow-outflow"];
export declare const getGetScannerInflowOutflowQueryOptions: <TData = Awaited<ReturnType<typeof getScannerInflowOutflow>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerInflowOutflow>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getScannerInflowOutflow>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetScannerInflowOutflowQueryResult = NonNullable<Awaited<ReturnType<typeof getScannerInflowOutflow>>>;
export type GetScannerInflowOutflowQueryError = ErrorType<unknown>;
/**
 * @summary Layer 14 — Exchange Inflow/Outflow pool
 */
export declare function useGetScannerInflowOutflow<TData = Awaited<ReturnType<typeof getScannerInflowOutflow>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getScannerInflowOutflow>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getTelegramWebhookUrl: () => string;
/**
 * Handles incoming Telegram bot updates
 * @summary Telegram webhook
 */
export declare const telegramWebhook: (telegramWebhookBody: TelegramWebhookBody, options?: RequestInit) => Promise<TelegramWebhook200>;
export declare const getTelegramWebhookMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof telegramWebhook>>, TError, {
        data: BodyType<TelegramWebhookBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof telegramWebhook>>, TError, {
    data: BodyType<TelegramWebhookBody>;
}, TContext>;
export type TelegramWebhookMutationResult = NonNullable<Awaited<ReturnType<typeof telegramWebhook>>>;
export type TelegramWebhookMutationBody = BodyType<TelegramWebhookBody>;
export type TelegramWebhookMutationError = ErrorType<unknown>;
/**
* @summary Telegram webhook
*/
export declare const useTelegramWebhook: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof telegramWebhook>>, TError, {
        data: BodyType<TelegramWebhookBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof telegramWebhook>>, TError, {
    data: BodyType<TelegramWebhookBody>;
}, TContext>;
export declare const getGetGrowthLeadersUrl: (params?: GetGrowthLeadersParams) => string;
/**
 * @summary Get BingX growth leaders snapshot from growth_leader_log
 */
export declare const getGrowthLeaders: (params?: GetGrowthLeadersParams, options?: RequestInit) => Promise<GrowthLeadersResponse>;
export declare const getGetGrowthLeadersQueryKey: (params?: GetGrowthLeadersParams) => readonly ["/api/scanner/growth-leaders", ...GetGrowthLeadersParams[]];
export declare const getGetGrowthLeadersQueryOptions: <TData = Awaited<ReturnType<typeof getGrowthLeaders>>, TError = ErrorType<unknown>>(params?: GetGrowthLeadersParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getGrowthLeaders>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getGrowthLeaders>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetGrowthLeadersQueryResult = NonNullable<Awaited<ReturnType<typeof getGrowthLeaders>>>;
export type GetGrowthLeadersQueryError = ErrorType<unknown>;
/**
 * @summary Get BingX growth leaders snapshot from growth_leader_log
 */
export declare function useGetGrowthLeaders<TData = Awaited<ReturnType<typeof getGrowthLeaders>>, TError = ErrorType<unknown>>(params?: GetGrowthLeadersParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getGrowthLeaders>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetOverheatLogUrl: (params?: GetOverheatLogParams) => string;
/**
 * @summary Get tokens kicked from prescan by the overheat filter (price24h > 40%)
 */
export declare const getOverheatLog: (params?: GetOverheatLogParams, options?: RequestInit) => Promise<OverheatLogResponse>;
export declare const getGetOverheatLogQueryKey: (params?: GetOverheatLogParams) => readonly ["/api/scanner/overheat-log", ...GetOverheatLogParams[]];
export declare const getGetOverheatLogQueryOptions: <TData = Awaited<ReturnType<typeof getOverheatLog>>, TError = ErrorType<unknown>>(params?: GetOverheatLogParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getOverheatLog>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getOverheatLog>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetOverheatLogQueryResult = NonNullable<Awaited<ReturnType<typeof getOverheatLog>>>;
export type GetOverheatLogQueryError = ErrorType<unknown>;
/**
 * @summary Get tokens kicked from prescan by the overheat filter (price24h > 40%)
 */
export declare function useGetOverheatLog<TData = Awaited<ReturnType<typeof getOverheatLog>>, TError = ErrorType<unknown>>(params?: GetOverheatLogParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getOverheatLog>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetLiqCascadeUrl: (params?: GetLiqCascadeParams) => string;
/**
 * Returns active watching entries and recent history for the independent dump detector
 * @summary Get Layer 10 Liquidation Cascade Watch entries
 */
export declare const getLiqCascade: (params?: GetLiqCascadeParams, options?: RequestInit) => Promise<LiqCascadeResponse>;
export declare const getGetLiqCascadeQueryKey: (params?: GetLiqCascadeParams) => readonly ["/api/liq-cascade", ...GetLiqCascadeParams[]];
export declare const getGetLiqCascadeQueryOptions: <TData = Awaited<ReturnType<typeof getLiqCascade>>, TError = ErrorType<unknown>>(params?: GetLiqCascadeParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getLiqCascade>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getLiqCascade>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetLiqCascadeQueryResult = NonNullable<Awaited<ReturnType<typeof getLiqCascade>>>;
export type GetLiqCascadeQueryError = ErrorType<unknown>;
/**
 * @summary Get Layer 10 Liquidation Cascade Watch entries
 */
export declare function useGetLiqCascade<TData = Awaited<ReturnType<typeof getLiqCascade>>, TError = ErrorType<unknown>>(params?: GetLiqCascadeParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getLiqCascade>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetTaScannerUrl: (params?: GetTaScannerParams) => string;
/**
 * Multi-timeframe technical analysis snapshot, refreshed every 5 minutes
 * @summary Get TA Scanner data (MA/EMA/MACD/TD/ATR for all tokens)
 */
export declare const getTaScanner: (params?: GetTaScannerParams, options?: RequestInit) => Promise<TaScannerResponse>;
export declare const getGetTaScannerQueryKey: (params?: GetTaScannerParams) => readonly ["/api/ta-scanner", ...GetTaScannerParams[]];
export declare const getGetTaScannerQueryOptions: <TData = Awaited<ReturnType<typeof getTaScanner>>, TError = ErrorType<unknown>>(params?: GetTaScannerParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTaScanner>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getTaScanner>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetTaScannerQueryResult = NonNullable<Awaited<ReturnType<typeof getTaScanner>>>;
export type GetTaScannerQueryError = ErrorType<unknown>;
/**
 * @summary Get TA Scanner data (MA/EMA/MACD/TD/ATR for all tokens)
 */
export declare function useGetTaScanner<TData = Awaited<ReturnType<typeof getTaScanner>>, TError = ErrorType<unknown>>(params?: GetTaScannerParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTaScanner>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export {};
//# sourceMappingURL=api.d.ts.map