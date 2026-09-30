export function buildPrioritySelectItems(
  t: (key: 'priorityLow' | 'priorityNormal' | 'priorityHigh' | 'priorityUrgent') => string,
): { value: string; label: string }[] {
  return [
    { value: 'low', label: t('priorityLow') },
    { value: 'normal', label: t('priorityNormal') },
    { value: 'high', label: t('priorityHigh') },
    { value: 'urgent', label: t('priorityUrgent') },
  ];
}
