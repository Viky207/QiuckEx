import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const SUPPORTED_CHANNELS = ['email', 'sms', 'push', 'in_app'] as const;
export type NotificationChannel = (typeof SUPPORTED_CHANNELS)[number];

export const SUPPORTED_FREQUENCIES = ['instant', 'daily', 'weekly', 'never'] as const;
export type NotificationFrequency = (typeof SUPPORTED_FREQUENCIES)[number];

export interface NotificationPreference {
  user_id: string;
  channel: NotificationChannel;
  frequency: NotificationFrequency;
  enabled: boolean;
}

export interface NotificationPreferenceUpdate {
  channel?: string;
  frequency?: string;
  enabled?: boolean;
}

export interface FieldValidationError {
  field: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldValidationError[] };

function isSupportedChannel(value: string): value is NotificationChannel {
  return (SUPPORTED_CHANNELS as readonly string[]).includes(value);
}

function isSupportedFrequency(value: string): value is NotificationFrequency {
  return (SUPPORTED_FREQUENCIES as readonly string[]).includes(value);
}

/**
 * Validate a notification preference update payload.
 * Returns field-level errors for unknown channel or frequency values.
 */
export function validatePreferenceUpdate(
  payload: NotificationPreferenceUpdate
): ValidationResult<NotificationPreferenceUpdate> {
  const errors: FieldValidationError[] = [];

  if (payload.channel !== undefined) {
    if (typeof payload.channel !== 'string' || !isSupportedChannel(payload.channel)) {
      errors.push({
        field: 'channel',
        message: `Unsupported channel. Expected one of: ${SUPPORTED_CHANNELS.join(', ')}`,
      });
    }
  }

  if (payload.frequency !== undefined) {
    if (typeof payload.frequency !== 'string' || !isSupportedFrequency(payload.frequency)) {
      errors.push({
        field: 'frequency',
        message: `Unsupported frequency. Expected one of: ${SUPPORTED_FREQUENCIES.join(', ')}`,
      });
    }
  }

  if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') {
    errors.push({ field: 'enabled', message: 'Expected a boolean value' });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: payload };
}

/**
 * Normalize a stored preference row so legacy values remain readable.
 * Unknown legacy channels/frequencies are preserved as-is rather than dropped.
 */
export function normalizeStoredPreference(row: Record<string, unknown>): NotificationPreference {
  return {
    user_id: String(row.user_id),
    channel: row.channel as NotificationChannel,
    frequency: row.frequency as NotificationFrequency,
    enabled: Boolean(row.enabled),
  };
}

export class NotificationPreferencesService {
  private readonly client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    this.client =
      client ??
      createClient(
        process.env.SUPABASE_URL as string,
        process.env.SUPABASE_SERVICE_ROLE_KEY as string
      );
  }

  async listForUser(userId: string): Promise<NotificationPreference[]> {
    const { data, error } = await this.client
      .from('notification_preferences')
      .select('user_id, channel, frequency, enabled')
      .eq('user_id', userId);

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) => normalizeStoredPreference(row as Record<string, unknown>));
  }

  /**
   * Update a single preference for the authenticated user.
   * Rejects cross-user updates and invalid channel/frequency values.
   */
  async updatePreference(
    authenticatedUserId: string,
    targetUserId: string,
    channel: string,
    payload: NotificationPreferenceUpdate
  ): Promise<ValidationResult<NotificationPreference>> {
    if (authenticatedUserId !== targetUserId) {
      return {
        ok: false,
        errors: [{ field: 'user_id', message: 'Cannot update another user\'s preferences' }],
      };
    }

    const validation = validatePreferenceUpdate({ ...payload, channel: payload.channel ?? channel });
    if (!validation.ok) {
      return validation;
    }

    const update: Record<string, unknown> = {};
    if (validation.value.channel !== undefined) update.channel = validation.value.channel;
    if (validation.value.frequency !== undefined) update.frequency = validation.value.frequency;
    if (validation.value.enabled !== undefined) update.enabled = validation.value.enabled;

    const { data, error } = await this.client
      .from('notification_preferences')
      .update(update)
      .eq('user_id', authenticatedUserId)
      .eq('channel', channel)
      .select('user_id, channel, frequency, enabled')
      .single();

    if (error) {
      throw error;
    }

    return { ok: true, value: normalizeStoredPreference(data as Record<string, unknown>) };
  }
}
