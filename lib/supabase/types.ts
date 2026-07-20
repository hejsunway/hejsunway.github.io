// AidoForMe-scoped database types. Keep this file limited to Aido-owned
// objects because the Supabase project is shared with TutorPakar.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type AidoMembershipStatus = "active" | "invited" | "suspended";
export type AidoMembershipRole = "student" | "reviewer" | "support";
export type AidoProjectStatus = "setup" | "active" | "archived";
export type AidoIntegrityMode =
  | "unknown"
  | "no_ai"
  | "planning_only"
  | "assistive_writing"
  | "open_required_ai";
export type AidoProjectMemberRole = "owner" | "editor" | "viewer";
export type AidoDocumentKind =
  | "brief"
  | "rubric"
  | "policy"
  | "template"
  | "source"
  | "other";
export type AidoDocumentStatus = "uploaded" | "processing" | "ready" | "failed";
export type AidoWalletStatus = "active" | "frozen" | "closed";
export type AidoCreditLotStatus = "active" | "depleted" | "expired" | "reversed";
export type AidoLedgerEntryType = "grant" | "reserve" | "capture" | "release" | "expiry" | "refund" | "reversal" | "adjustment";
export type AidoSubscriptionStatus = "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused";

export type AidoProductMembership = {
  id: string;
  user_id: string;
  status: AidoMembershipStatus;
  role: AidoMembershipRole;
  created_at: string;
  updated_at: string;
};

export type AidoWritingProject = {
  id: string;
  owner_id: string;
  title: string;
  course_name: string | null;
  assignment_type: string;
  deadline: string | null;
  target_word_count: number | null;
  citation_style: string;
  integrity_mode: AidoIntegrityMode;
  policy_text: string | null;
  status: AidoProjectStatus;
  created_at: string;
  updated_at: string;
};

export type AidoAssignmentDocument = {
  id: string;
  project_id: string;
  uploaded_by: string;
  kind: AidoDocumentKind;
  original_filename: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  content_hash: string | null;
  status: AidoDocumentStatus;
  failure_code: string | null;
  failure_message: string | null;
  replaces_document_id: string | null;
  replaced_by_document_id: string | null;
  replaced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AidoProjectActivity = {
  id: number;
  project_id: string;
  actor_id: string;
  event_type: string;
  metadata: Json;
  created_at: string;
};

export type AidoProjectPolicy = {
  id: string;
  project_id: string;
  confirmed_by: string;
  integrity_mode: AidoIntegrityMode;
  policy_text: string | null;
  is_confirmed: boolean;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AidoProjectDeletionAudit = {
  id: number;
  deleted_project_id: string;
  owner_id: string;
  project_title: string;
  storage_paths: string[];
  deleted_at: string;
};

type TableShape<Row, Insert, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      aido_product_memberships: TableShape<
        AidoProductMembership,
        {
          id?: string;
          user_id: string;
          status?: AidoMembershipStatus;
          role?: AidoMembershipRole;
          created_at?: string;
          updated_at?: string;
        }
      >;
      aido_writing_projects: TableShape<
        AidoWritingProject,
        {
          id?: string;
          owner_id: string;
          title: string;
          course_name?: string | null;
          assignment_type: string;
          deadline?: string | null;
          target_word_count?: number | null;
          citation_style?: string;
          integrity_mode?: AidoIntegrityMode;
          policy_text?: string | null;
          status?: AidoProjectStatus;
          created_at?: string;
          updated_at?: string;
        }
      >;
      aido_project_members: TableShape<
        {
          id: string;
          project_id: string;
          user_id: string;
          role: AidoProjectMemberRole;
          created_at: string;
        },
        {
          id?: string;
          project_id: string;
          user_id: string;
          role: AidoProjectMemberRole;
          created_at?: string;
        }
      >;
      aido_project_policies: TableShape<
        AidoProjectPolicy,
        {
          id?: string;
          project_id: string;
          confirmed_by: string;
          integrity_mode: AidoIntegrityMode;
          policy_text?: string | null;
          is_confirmed?: boolean;
          confirmed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      aido_assignment_documents: TableShape<
        AidoAssignmentDocument,
        {
          id?: string;
          project_id: string;
          uploaded_by: string;
          kind: AidoDocumentKind;
          original_filename: string;
          storage_bucket?: string;
          storage_path: string;
          mime_type: string;
          size_bytes: number;
          content_hash?: string | null;
          status?: AidoDocumentStatus;
          failure_code?: string | null;
          failure_message?: string | null;
          replaces_document_id?: string | null;
          replaced_by_document_id?: string | null;
          replaced_at?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      aido_project_activity: TableShape<
        AidoProjectActivity,
        {
          id?: number;
          project_id: string;
          actor_id: string;
          event_type: string;
          metadata?: Json;
          created_at?: string;
        }
      >;
      aido_project_deletion_audit: TableShape<
        AidoProjectDeletionAudit,
        {
          id?: number;
          deleted_project_id: string;
          owner_id: string;
          project_title: string;
          storage_paths?: string[];
          deleted_at?: string;
        }
      >;
      aido_credit_wallets: TableShape<
        { user_id: string; available_credits: number; reserved_credits: number; unrecovered_credits: number; status: AidoWalletStatus; version: number; created_at: string; updated_at: string },
        { user_id: string; available_credits?: number; reserved_credits?: number; unrecovered_credits?: number; status?: AidoWalletStatus; version?: number; created_at?: string; updated_at?: string }
      >;
      aido_credit_lots: TableShape<
        { id: string; user_id: string; source: string; credit_product_id: string | null; payment_event_id: string | null; granted_credits: number; remaining_credits: number; reserved_credits: number; status: AidoCreditLotStatus; expires_at: string | null; created_at: string; updated_at: string },
        { id?: string; user_id: string; source: string; credit_product_id?: string | null; payment_event_id?: string | null; granted_credits: number; remaining_credits: number; reserved_credits?: number; status?: AidoCreditLotStatus; expires_at?: string | null; created_at?: string; updated_at?: string }
      >;
      aido_credit_ledger: TableShape<
        { id: number; user_id: string; entry_type: AidoLedgerEntryType; credit_lot_id: string | null; reservation_id: string | null; payment_event_id: string | null; related_ledger_id: number | null; available_delta: number; reserved_delta: number; unrecovered_delta: number; available_balance_after: number; reserved_balance_after: number; unrecovered_balance_after: number; idempotency_key: string; metadata: Json; created_at: string },
        { id?: number; user_id: string; entry_type: AidoLedgerEntryType; credit_lot_id?: string | null; reservation_id?: string | null; payment_event_id?: string | null; related_ledger_id?: number | null; available_delta?: number; reserved_delta?: number; unrecovered_delta?: number; available_balance_after: number; reserved_balance_after: number; unrecovered_balance_after: number; idempotency_key: string; metadata?: Json; created_at?: string }
      >;
      aido_payment_events: TableShape<
        { id: string; stripe_event_id: string; stripe_event_type: string; event_kind: string; livemode: boolean; stripe_object_id: string; related_payment_event_id: string | null; user_id: string | null; credit_product_id: string | null; currency: string | null; amount_gross_sen: number | null; amount_net_sen: number | null; credits_affected: number | null; payload_sha256: string; status: string; failure_code: string | null; failure_message: string | null; received_at: string; processed_at: string | null },
        { id?: string; stripe_event_id: string; stripe_event_type: string; event_kind: string; livemode: boolean; stripe_object_id: string; related_payment_event_id?: string | null; user_id?: string | null; credit_product_id?: string | null; currency?: string | null; amount_gross_sen?: number | null; amount_net_sen?: number | null; credits_affected?: number | null; payload_sha256: string; status?: string; failure_code?: string | null; failure_message?: string | null; received_at?: string; processed_at?: string | null }
      >;
      aido_subscriptions: TableShape<
        { id: string; user_id: string; credit_product_id: string; stripe_customer_id: string; stripe_subscription_id: string; stripe_price_id: string; status: AidoSubscriptionStatus; cancel_at_period_end: boolean; current_period_start: string; current_period_end: string; cancel_at: string | null; canceled_at: string | null; ended_at: string | null; trial_start: string | null; trial_end: string | null; latest_invoice_id: string | null; last_payment_failed_at: string | null; livemode: boolean; last_stripe_event_id: string; last_stripe_event_type: string; last_event_created_at: string; last_synced_at: string; created_at: string; updated_at: string },
        { id?: string; user_id: string; credit_product_id: string; stripe_customer_id: string; stripe_subscription_id: string; stripe_price_id: string; status: AidoSubscriptionStatus; cancel_at_period_end?: boolean; current_period_start: string; current_period_end: string; cancel_at?: string | null; canceled_at?: string | null; ended_at?: string | null; trial_start?: string | null; trial_end?: string | null; latest_invoice_id?: string | null; last_payment_failed_at?: string | null; livemode: boolean; last_stripe_event_id: string; last_stripe_event_type: string; last_event_created_at: string; last_synced_at?: string; created_at?: string; updated_at?: string }
      >;
    };
    Views: Record<string, never>;
    Functions: {
      aido_create_project: {
        Args: {
          p_title: string;
          p_course_name: string;
          p_assignment_type: string;
          p_deadline: string | null;
          p_target_word_count: number | null;
          p_citation_style: string;
          p_integrity_mode: AidoIntegrityMode;
          p_policy_text: string;
        };
        Returns: string;
      };
      aido_register_assignment_document: {
        Args: {
          p_project_id: string;
          p_kind: AidoDocumentKind;
          p_original_filename: string;
          p_storage_path: string;
          p_mime_type: string;
          p_size_bytes: number;
          p_content_hash: string;
        };
        Returns: string;
      };
      aido_complete_project_setup: {
        Args: { p_project_id: string };
        Returns: undefined;
      };
      aido_replace_assignment_document: {
        Args: {
          p_project_id: string;
          p_replaces_document_id: string;
          p_kind: AidoDocumentKind;
          p_original_filename: string;
          p_storage_path: string;
          p_mime_type: string;
          p_size_bytes: number;
          p_content_hash: string;
        };
        Returns: string;
      };
      aido_delete_project: {
        Args: { p_project_id: string };
        Returns: undefined;
      };
    };
    Enums: {
      aido_membership_status: AidoMembershipStatus;
      aido_membership_role: AidoMembershipRole;
      aido_project_status: AidoProjectStatus;
      aido_integrity_mode: AidoIntegrityMode;
      aido_project_member_role: AidoProjectMemberRole;
      aido_document_kind: AidoDocumentKind;
      aido_document_status: AidoDocumentStatus;
      aido_wallet_status: AidoWalletStatus;
      aido_credit_lot_status: AidoCreditLotStatus;
      aido_ledger_entry_type: AidoLedgerEntryType;
    };
    CompositeTypes: Record<string, never>;
  };
};
