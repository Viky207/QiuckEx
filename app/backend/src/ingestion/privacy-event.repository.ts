import { Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service";
import type { PrivacyToggledEvent } from "./types/contract-event.types";

export interface KeyRotationEvent {
  eventType: "KeyRotationAnnounced" | "KeyRotationActivated" | "KeyRotationRevoked";
  eventId: string;
  username: string;
  schemaVersion: number;
  contractTimestamp: bigint | number | string;
  txHash: string;
  ledgerSequence: number;
  pagingToken: string;
}

/**
 * Field-level privacy and retention reference for the `privacy_events` table.
 *
 * This inventory is the source of truth for which fields are persisted, why,
 * how long they are retained, and how they are removed. It must be kept in
 * sync with the actual storage schema and any logging that touches these
 * fields. Fields that are not listed here are flagged for review rather than
 * assumed absent.
 *
 * | Field              | Category            | Purpose                                   | Retention                                   | Deletion behavior                                  |
 * | ------------------ | ------------------- | ----------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
 * | event_type         | Event metadata      | Distinguish privacy toggle event kind     | Life of the event row                       | Removed with the event row                         |
 * | event_id           | Event metadata      | Idempotent dedupe of on-chain events      | Life of the event row                       | Removed with the event row                         |
 * | owner              | Personal data       | Identify whose privacy setting changed    | Life of the event row                       | Removed with the event row                         |
 * | enabled            | Preference data     | Record the resulting privacy state        | Life of the event row                       | Removed with the event row                         |
 * | schema_version     | Event metadata      | Decode payloads across contract versions  | Life of the event row                       | Removed with the event row                         |
 * | contract_timestamp | Event metadata      | Ordering and audit of on-chain time       | Life of the event row                       | Removed with the event row                         |
 * | tx_hash            | Chain reference     | Link event to its on-chain transaction    | Life of the event row                       | Removed with the event row                         |
 * | ledger_sequence    | Chain reference     | Ordering and replay of ledger events      | Life of the event row                       | Removed with the event row                         |
 * | paging_token       | Chain reference     | Cursor for ingestion pagination           | Life of the event row                       | Removed with the event row                         |
 *
 * No secrets, signing material, or unnecessary personal data are stored or
 * logged by this repository. Log lines reference only the owner identifier
 * needed to trace a failed write.
 */
export const PRIVACY_EVENT_FIELD_INVENTORY = [
  { field: "event_type", category: "event_metadata", purpose: "privacy toggle event kind", retention: "life_of_row", deletion: "row_delete" },
  { field: "event_id", category: "event_metadata", purpose: "idempotent dedupe", retention: "life_of_row", deletion: "row_delete" },
  { field: "owner", category: "personal_data", purpose: "identify affected account", retention: "life_of_row", deletion: "row_delete" },
  { field: "enabled", category: "preference_data", purpose: "resulting privacy state", retention: "life_of_row", deletion: "row_delete" },
  { field: "schema_version", category: "event_metadata", purpose: "payload versioning", retention: "life_of_row", deletion: "row_delete" },
  { field: "contract_timestamp", category: "event_metadata", purpose: "on-chain ordering", retention: "life_of_row", deletion: "row_delete" },
  { field: "tx_hash", category: "chain_reference", purpose: "link to transaction", retention: "life_of_row", deletion: "row_delete" },
  { field: "ledger_sequence", category: "chain_reference", purpose: "ledger ordering", retention: "life_of_row", deletion: "row_delete" },
  { field: "paging_token", category: "chain_reference", purpose: "ingestion cursor", retention: "life_of_row", deletion: "row_delete" },
] as const;

@Injectable()
export class PrivacyEventRepository {
  private readonly logger = new Logger(PrivacyEventRepository.name);

  constructor(private readonly supabase: SupabaseService) {}

  async upsertEvent(event: PrivacyToggledEvent): Promise<boolean> {
    const { data, error } = await this.supabase.getClient()
      .from("privacy_events")
      .upsert(
        {
          event_type: event.eventType,
          event_id: event.eventId,
          owner: event.owner,
          enabled: event.enabled,
          schema_version: event.schemaVersion,
          contract_timestamp: Number(event.contractTimestamp),
          tx_hash: event.txHash,
          ledger_sequence: event.ledgerSequence,
          paging_token: event.pagingToken,
        },
        { onConflict: "tx_hash,event_type,owner", ignoreDuplicates: true },
      )
      .select("id");

    if (error) {
      // Log only the owner identifier needed to trace the failure; never log
      // secrets, signing material, or the full event payload.
      this.logger.error(`Failed to upsert PrivacyToggled for owner ${event.owner}: ${error.message}`);
      throw error;
    }
    return Boolean(data?.length);
  }

  async upsertKeyRotationEvent(event: KeyRotationEvent): Promise<boolean> {
    const { data, error } = await this.supabase.getClient()
      .from("key_rotation_events")
      .upsert(
        {
          event_type: event.eventType,
          event_id: event.eventId,
          username: event.username,
          schema_version: event.schemaVersion,
          contract_timestamp: Number(event.contractTimestamp),
          tx_hash: event.txHash,
          ledger_sequence: event.ledgerSequence,
          paging_token: event.pagingToken,
        },
        { onConflict: "tx_hash,event_type,username", ignoreDuplicates: true },
      )
      .select("id");

    if (error) {
      // Log only the username identifier needed to trace the failure; never log
      // secrets, signing material, or the full event payload.
      this.logger.error(
        `Failed to upsert ${event.eventType} for username ${event.username}: ${error.message}`,
      );
      throw error;
    }
    return Boolean(data?.length);
  }
}