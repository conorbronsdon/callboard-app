/**
 * The WS1a form-schema seam.
 *
 * WS1b consumes the form contract THROUGH this module rather than importing
 * `~/lib/form-schema` in a dozen places, so a contract change is one file's
 * problem. It now re-exports the REAL WS1a evaluator (merged from
 * `ws1a-form-builder` at commit 829b34b) — the local mock this file used to
 * point at has been deleted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SURFACE WS1b CONSUMES
 *   shapes     FormDefinition, FormFieldRef, FormAnswers, ParticipantAnswers,
 *              AnswerValue, CombinedCounter, ValidationIssue, ValidationResult,
 *              ParticipantRoleConfig, FormSettings, StepCopy
 *   build      toFormDefinition(row)          — `forms` row + JSON -> definition
 *   render     visibleFields(answers, def)    — conditional show/hide
 *              fieldStates(answers, def, …)   — visibility + requiredness
 *              combinedCounters(answers, def) — live cross-field counters
 *   validate   validate(answers, def, { now, draft })
 *   route      routeCategory(answers, def)
 *   gates      isFormOpen(def, now), effectiveSubmissionLimit(def, eventLimit)
 *   text       textOf(value, type), countChars(value, type), isBlank(value)
 *
 * WS1b adds on top (in `./wizard.ts`, which WS1a does not own): the 5-step
 * public step model, the stepper labels, the close-date sentence, the live
 * participant role indicators, and the abstract-vs-video content block.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export * from "~/lib/form-schema";

/** Which implementation is wired up — asserted in the wizard unit tests. */
export const FORM_SCHEMA_SOURCE = "ws1a-form-schema" as const;
