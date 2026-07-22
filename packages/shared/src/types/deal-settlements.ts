import type {
  DealAttributionConfidence,
  DealEventKind,
  DealSettlementStatus,
  FinanceDirection,
} from "../constants.js";

export interface DealSettlementLeg {
  eventKind: DealEventKind;
  direction: FinanceDirection;
  amountCents: number;
  description: string | null;
  occurredAt: string | null;
  estimated: boolean;
}

export interface DealSettlement {
  id: string;
  companyId: string;
  dealKey: string;
  revision: number;
  vin: string | null;
  vehicleDescription: string | null;
  soldAt: Date | null;
  originIssueId: string | null;
  originGoalId: string | null;
  originProjectId: string | null;
  createdByAgentId: string | null;
  attributionConfidence: DealAttributionConfidence;
  status: DealSettlementStatus;
  currency: string;
  legsJson: DealSettlementLeg[];
  acquisitionCents: number | null;
  reconHoldingCents: number | null;
  saleProceedsCents: number | null;
  realizedGrossCents: number | null;
  realizedNetCents: number | null;
  committedByUserId: string | null;
  committedAt: Date | null;
  reversedAt: Date | null;
  reversalReason: string | null;
  notes: string | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}
