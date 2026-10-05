export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          deleted_at: string | null
          email: string | null
          id: string
          name: string | null
          updated_at: string
          x_handle: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id: string
          name?: string | null
          updated_at?: string
          x_handle?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          name?: string | null
          updated_at?: string
          x_handle?: string | null
        }
        Relationships: []
      }
      provider_connections: {
        Row: {
          connected_at: string | null
          connection_status: string
          created_at: string
          error_code: string | null
          external_account_ref: string | null
          id: string
          key_last4: string | null
          last_reconcile_at: string | null
          last_verified_at: string | null
          provider: string
          racer_id: string
          updated_at: string
        }
        Insert: {
          connected_at?: string | null
          connection_status?: string
          created_at?: string
          error_code?: string | null
          external_account_ref?: string | null
          id?: string
          key_last4?: string | null
          last_reconcile_at?: string | null
          last_verified_at?: string | null
          provider: string
          racer_id: string
          updated_at?: string
        }
        Update: {
          connected_at?: string | null
          connection_status?: string
          created_at?: string
          error_code?: string | null
          external_account_ref?: string | null
          id?: string
          key_last4?: string | null
          last_reconcile_at?: string | null
          last_verified_at?: string | null
          provider?: string
          racer_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_connections_racer_id_fkey"
            columns: ["racer_id"]
            isOneToOne: false
            referencedRelation: "racer"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_credentials: {
        Row: {
          created_at: string
          encrypted_secret: string
          id: string
          key_version: number
          provider_connection_id: string
          rotated_at: string | null
        }
        Insert: {
          created_at?: string
          encrypted_secret: string
          id?: string
          key_version?: number
          provider_connection_id: string
          rotated_at?: string | null
        }
        Update: {
          created_at?: string
          encrypted_secret?: string
          id?: string
          key_version?: number
          provider_connection_id?: string
          rotated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provider_credentials_provider_connection_id_fkey"
            columns: ["provider_connection_id"]
            isOneToOne: true
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      race_baseline_customer: {
        Row: {
          created_at: string
          external_customer_id: string
          id: string
          racer_id: string
        }
        Insert: {
          created_at?: string
          external_customer_id: string
          id?: string
          racer_id: string
        }
        Update: {
          created_at?: string
          external_customer_id?: string
          id?: string
          racer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "race_baseline_customer_racer_id_fkey"
            columns: ["racer_id"]
            isOneToOne: false
            referencedRelation: "racer"
            referencedColumns: ["id"]
          },
        ]
      }
      race_config: {
        Row: {
          duration_days: number
          id: boolean
          updated_at: string
        }
        Insert: {
          duration_days: number
          id?: boolean
          updated_at?: string
        }
        Update: {
          duration_days?: number
          id?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      race_customer: {
        Row: {
          created_at: string
          external_customer_id: string
          first_paid_at: string
          id: string
          provider_payment_id: string | null
          racer_id: string
        }
        Insert: {
          created_at?: string
          external_customer_id: string
          first_paid_at: string
          id?: string
          provider_payment_id?: string | null
          racer_id: string
        }
        Update: {
          created_at?: string
          external_customer_id?: string
          first_paid_at?: string
          id?: string
          provider_payment_id?: string | null
          racer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "race_customer_racer_id_fkey"
            columns: ["racer_id"]
            isOneToOne: false
            referencedRelation: "racer"
            referencedColumns: ["id"]
          },
        ]
      }
      race_event: {
        Row: {
          created_at: string
          event_type: Database["public"]["Enums"]["race_event_type"]
          id: string
          milestone_customer_count: number | null
          occurred_at: string
          racer_id: string
        }
        Insert: {
          created_at?: string
          event_type: Database["public"]["Enums"]["race_event_type"]
          id?: string
          milestone_customer_count?: number | null
          occurred_at?: string
          racer_id: string
        }
        Update: {
          created_at?: string
          event_type?: Database["public"]["Enums"]["race_event_type"]
          id?: string
          milestone_customer_count?: number | null
          occurred_at?: string
          racer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "race_event_racer_id_fkey"
            columns: ["racer_id"]
            isOneToOne: false
            referencedRelation: "racer"
            referencedColumns: ["id"]
          },
        ]
      }
      racer: {
        Row: {
          activated_at: string | null
          baseline_captured_at: string | null
          baseline_customer_count: number | null
          city: string | null
          count_reconciled_at: string | null
          country: string | null
          created_at: string
          current_customer_count: number
          id: string
          latitude: number | null
          longitude: number | null
          product_name: string | null
          product_url: string | null
          profile_id: string | null
          public_consent_at: string | null
          public_slug: string | null
          race_end_at: string | null
          reached_ten_at: string | null
          status: Database["public"]["Enums"]["racer_status"]
        }
        Insert: {
          activated_at?: string | null
          baseline_captured_at?: string | null
          baseline_customer_count?: number | null
          city?: string | null
          count_reconciled_at?: string | null
          country?: string | null
          created_at?: string
          current_customer_count?: number
          id?: string
          latitude?: number | null
          longitude?: number | null
          product_name?: string | null
          product_url?: string | null
          profile_id?: string | null
          public_consent_at?: string | null
          public_slug?: string | null
          race_end_at?: string | null
          reached_ten_at?: string | null
          status?: Database["public"]["Enums"]["racer_status"]
        }
        Update: {
          activated_at?: string | null
          baseline_captured_at?: string | null
          baseline_customer_count?: number | null
          city?: string | null
          count_reconciled_at?: string | null
          country?: string | null
          created_at?: string
          current_customer_count?: number
          id?: string
          latitude?: number | null
          longitude?: number | null
          product_name?: string | null
          product_url?: string | null
          profile_id?: string | null
          public_consent_at?: string | null
          public_slug?: string | null
          race_end_at?: string | null
          reached_ten_at?: string | null
          status?: Database["public"]["Enums"]["racer_status"]
        }
        Relationships: [
          {
            foreignKeyName: "racer_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_counter: {
        Row: {
          attempts: number
          bucket: string
          id: string
          subject: string
          updated_at: string
          window_start: string
        }
        Insert: {
          attempts?: number
          bucket: string
          id?: string
          subject: string
          updated_at?: string
          window_start: string
        }
        Update: {
          attempts?: number
          bucket?: string
          id?: string
          subject?: string
          updated_at?: string
          window_start?: string
        }
        Relationships: []
      }
      reconciliation_runs: {
        Row: {
          completed_at: string | null
          customer_count: number | null
          error_code: string | null
          id: string
          mrr_minor: number | null
          provider_connection_id: string
          started_at: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          customer_count?: number | null
          error_code?: string | null
          id?: string
          mrr_minor?: number | null
          provider_connection_id: string
          started_at?: string
          status?: string
        }
        Update: {
          completed_at?: string | null
          customer_count?: number | null
          error_code?: string | null
          id?: string
          mrr_minor?: number | null
          provider_connection_id?: string
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_runs_provider_connection_id_fkey"
            columns: ["provider_connection_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      sponsor_pricing: {
        Row: {
          price_cents: number
          term_days: number
          updated_at: string
        }
        Insert: {
          price_cents: number
          term_days: number
          updated_at?: string
        }
        Update: {
          price_cents?: number
          term_days?: number
          updated_at?: string
        }
        Relationships: []
      }
      sponsor_slot: {
        Row: {
          created_at: string
          id: string
          placement: Database["public"]["Enums"]["slot_placement"]
          slot_number: number
        }
        Insert: {
          created_at?: string
          id?: string
          placement: Database["public"]["Enums"]["slot_placement"]
          slot_number: number
        }
        Update: {
          created_at?: string
          id?: string
          placement?: Database["public"]["Enums"]["slot_placement"]
          slot_number?: number
        }
        Relationships: []
      }
      sponsorship: {
        Row: {
          created_at: string
          ends_at: string
          hold_expires_at: string | null
          id: string
          price_cents: number
          slot_id: string
          sponsor_description: string
          sponsor_link: string
          sponsor_logo_url: string | null
          sponsor_name: string
          starts_at: string
          status: Database["public"]["Enums"]["sponsorship_status"]
          term_days: number
        }
        Insert: {
          created_at?: string
          ends_at: string
          hold_expires_at?: string | null
          id?: string
          price_cents: number
          slot_id: string
          sponsor_description: string
          sponsor_link: string
          sponsor_logo_url?: string | null
          sponsor_name: string
          starts_at: string
          status?: Database["public"]["Enums"]["sponsorship_status"]
          term_days: number
        }
        Update: {
          created_at?: string
          ends_at?: string
          hold_expires_at?: string | null
          id?: string
          price_cents?: number
          slot_id?: string
          sponsor_description?: string
          sponsor_link?: string
          sponsor_logo_url?: string | null
          sponsor_name?: string
          starts_at?: string
          status?: Database["public"]["Enums"]["sponsorship_status"]
          term_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "sponsorship_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "sponsor_slot"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_snapshots: {
        Row: {
          captured_at: string
          currency: string | null
          customer_count: number
          error_code: string | null
          id: string
          mrr_minor: number | null
          provider_connection_id: string
          racer_id: string
          source: string
          verification_status: string
        }
        Insert: {
          captured_at?: string
          currency?: string | null
          customer_count: number
          error_code?: string | null
          id?: string
          mrr_minor?: number | null
          provider_connection_id: string
          racer_id: string
          source: string
          verification_status: string
        }
        Update: {
          captured_at?: string
          currency?: string | null
          customer_count?: number
          error_code?: string | null
          id?: string
          mrr_minor?: number | null
          provider_connection_id?: string
          racer_id?: string
          source?: string
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "verification_snapshots_provider_connection_id_fkey"
            columns: ["provider_connection_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_snapshots_racer_id_fkey"
            columns: ["racer_id"]
            isOneToOne: false
            referencedRelation: "racer"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist_signup: {
        Row: {
          created_at: string
          customers_now: Database["public"]["Enums"]["customer_band"]
          email: string
          id: string
        }
        Insert: {
          created_at?: string
          customers_now: Database["public"]["Enums"]["customer_band"]
          email: string
          id?: string
        }
        Update: {
          created_at?: string
          customers_now?: Database["public"]["Enums"]["customer_band"]
          email?: string
          id?: string
        }
        Relationships: []
      }
    }
    Views: {
      public_race_events: {
        Row: {
          city: string | null
          country: string | null
          event_type: Database["public"]["Enums"]["race_event_type"] | null
          founder_name: string | null
          milestone_customer_count: number | null
          occurred_at: string | null
          product_name: string | null
          public_slug: string | null
          x_handle: string | null
        }
        Relationships: []
      }
      public_racers: {
        Row: {
          activated_at: string | null
          city: string | null
          country: string | null
          created_at: string | null
          current_customer_count: number | null
          founder_name: string | null
          latitude: number | null
          longitude: number | null
          product_name: string | null
          public_slug: string | null
          race_end_at: string | null
          reached_ten_at: string | null
          status: Database["public"]["Enums"]["racer_status"] | null
          x_handle: string | null
        }
        Relationships: []
      }
      public_search: {
        Row: {
          founder_name: string | null
          product_name: string | null
          public_slug: string | null
          x_handle: string | null
        }
        Relationships: []
      }
      public_sponsor_slots: {
        Row: {
          placement: Database["public"]["Enums"]["slot_placement"] | null
          slot_number: number | null
        }
        Insert: {
          placement?: Database["public"]["Enums"]["slot_placement"] | null
          slot_number?: number | null
        }
        Update: {
          placement?: Database["public"]["Enums"]["slot_placement"] | null
          slot_number?: number | null
        }
        Relationships: []
      }
      sponsorship_live: {
        Row: {
          ends_at: string | null
          id: string | null
          placement: Database["public"]["Enums"]["slot_placement"] | null
          slot_id: string | null
          slot_number: number | null
          sponsor_description: string | null
          sponsor_link: string | null
          sponsor_logo_url: string | null
          sponsor_name: string | null
          starts_at: string | null
          term_days: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sponsorship_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "sponsor_slot"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist_stats: {
        Row: {
          total: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      customer_band: "0" | "1-5" | "6+"
      race_event_type:
        | "joined"
        | "activated"
        | "customer_milestone"
        | "finished"
        | "expired"
        | "connection_lost"
      racer_status:
        | "registered"
        | "ready"
        | "racing"
        | "finished"
        | "verification_failed"
        | "withdrawn"
        | "disqualified"
        | "ineligible"
        | "expired"
      slot_placement:
        | "sidebar-left"
        | "sidebar-right"
        | "bar-top"
        | "bar-bottom"
      sponsorship_status: "pending" | "confirmed" | "cancelled" | "expired"
      verification_provider: "stripe" | "lemonsqueezy"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      customer_band: ["0", "1-5", "6+"],
      race_event_type: [
        "joined",
        "activated",
        "customer_milestone",
        "finished",
        "expired",
        "connection_lost",
      ],
      racer_status: [
        "registered",
        "ready",
        "racing",
        "finished",
        "verification_failed",
        "withdrawn",
        "disqualified",
        "ineligible",
        "expired",
      ],
      slot_placement: [
        "sidebar-left",
        "sidebar-right",
        "bar-top",
        "bar-bottom",
      ],
      sponsorship_status: ["pending", "confirmed", "cancelled", "expired"],
      verification_provider: ["stripe", "lemonsqueezy"],
    },
  },
} as const
