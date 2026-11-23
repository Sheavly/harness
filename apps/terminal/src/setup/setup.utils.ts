/** Invalid stored scalar values start empty so the form can repair them. */
export function fieldText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return '';
}

export function modelActions(params: { usable: boolean; hasSecrets: boolean }) {
  const items = [{ value: 'edit', label: 'Edit model settings' }];

  if (params.hasSecrets) items.unshift({ value: 'key', label: 'Set or replace API key' });

  if (params.usable) {
    items.unshift(
      { value: 'start', label: 'Save and finish' },
      { value: 'check', label: 'Test connection (makes a small API call)' },
    );
  }

  return items;
}
