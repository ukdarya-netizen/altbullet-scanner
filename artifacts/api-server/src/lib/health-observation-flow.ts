/** Control boundary shared by watcher tests and the lifecycle call site. */
export function resolveHealthObservationFlow(
  telegramEnabled: boolean,
  hasClassifiedState: boolean,
) {
  return {
    persistObservation: hasClassifiedState,
    sendTelegram: telegramEnabled && hasClassifiedState,
    continueLifecycle: true,
  };
}
