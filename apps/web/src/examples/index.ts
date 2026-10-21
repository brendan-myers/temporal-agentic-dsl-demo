// The template workflows, as plain JSON (the same shape the builder exports).
// The builder offers them; the API seeds saved flows from them.
import type { WorkflowDefinition } from '@demo/dsl';
import refundTriageJson from './refund-triage.json';
import leadQualificationJson from './lead-qualification.json';
import incidentResponseJson from './incident-response.json';

export const refundTriage = refundTriageJson as unknown as WorkflowDefinition;
export const leadQualification = leadQualificationJson as unknown as WorkflowDefinition;
export const incidentResponse = incidentResponseJson as unknown as WorkflowDefinition;

export const EXAMPLES: WorkflowDefinition[] = [refundTriage, leadQualification, incidentResponse];
