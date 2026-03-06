# Self-Attribution Bias Analysis for Agent Brain

## The Finding (arXiv:2603.04582)

LLMs evaluating actions show systematic leniency when those actions are framed as their own work vs. external work. Key points:

- **The Bias**: Models rate identical code/actions more favorably when presented as "self-generated" vs "from an external source"
- **Why It Matters**: Self-review evaluations become artificially inflated, making monitors appear more reliable than they actually are in deployment
- **Critical Finding**: Explicit source labeling (saying "this came from another agent") does NOT prevent the bias

## Agent Brain Vulnerability Analysis

### Primary Vulnerability: Phase 8 Self-Review

Current implementation in `fly-agent-runner/server.js:196`:
- **Task execution**: Uses Claude Sonnet (or specified model)
- **Self-review**: Uses Claude Haiku

**The Problem**: Both are Claude models. Even though they're different sizes, they're in the same model family and may share implicit self-identification patterns. The review prompt says "A coding agent just completed a task" — this vague framing doesn't help because the bias isn't about explicit attribution.

**Impact**: The self-review may be systematically passing code that should be flagged for human review. Bad changes could slip through to "completed" status without triggering the `needs_review` state.

### Secondary Vulnerabilities

1. **Pre-review self-validation** (CLAUDE.md checklist): Claude sessions validate their own work before checkpoints. Same-family bias applies.

2. **Memory fact extraction**: Agents decide which facts to write to `memory_facts`. Biased toward viewing own work positively.

3. **Checkpoint "task complete" framing**: Agents assess when their work is done. May declare completion prematurely.

## Mitigation Options

### Option A: Cross-Family Review (Recommended)

Use a different model family for review than for execution.

**Implementation**:
- Keep Claude Sonnet/Opus for task execution
- Switch self-review to OpenAI GPT-4o-mini or Google Gemini Flash
- ~$0.001-0.002 per review (similar cost to Haiku)

**Pros**: Eliminates family-level bias entirely
**Cons**: Adds dependency on second provider, slight latency increase

### Option B: Adversarial Prompting

Reframe the review prompt to be explicitly adversarial.

**Current**: "A coding agent just completed a task. Review the diff..."
**Proposed**: "You are a skeptical senior engineer reviewing code from an untrusted contractor. Your job is to find reasons to REJECT this code. List every possible issue, no matter how small. Assume the code is guilty until proven innocent."

**Pros**: No new dependencies, easy to implement
**Cons**: May overcorrect (too many false rejections), doesn't address underlying bias

### Option C: Mechanical Validation First

Add structured checks before any LLM review.

**Implementation**:
1. Syntax validation (node -c, eslint --no-fix)
2. Type checking (if TypeScript)
3. Test runner (if tests exist)
4. Only LLM reviews if mechanical checks pass

**Pros**: Objective, unbias-able checks catch obvious issues
**Cons**: Doesn't catch logic errors, task mismatches

### Option D: Calibration Baseline (Detection Only)

Periodically inject known-bad diffs to verify the reviewer is catching problems.

**Implementation**:
- 10% of reviews are "canary" reviews with intentionally buggy code
- Track pass/fail rate on canaries vs real reviews
- Alert if canary pass rate exceeds threshold

**Pros**: Quantifies actual bias level over time
**Cons**: Doesn't prevent bias, just detects it

## Recommendation

**Implement Options A + C together**:

1. **Cross-family review**: Replace Haiku self-review with GPT-4o-mini
   - Cost: ~$0.002/review (similar to Haiku at ~$0.001)
   - Eliminates same-family bias
   - Fast enough for blocking review (2-3s)

2. **Mechanical validation first**: Add syntax/lint checks before LLM review
   - Catches objective issues before biased review
   - Reduces LLM review load (skip if syntax fails)

3. **Keep human oversight**: Maintain `needs_review` path and checkpoint system
   - Self-review is a first filter, not final authority
   - Critical tasks still require human approval

## Implementation Estimate

- Add OpenAI SDK or use direct API call
- Modify `selfReview()` to call GPT-4o-mini instead of Haiku
- Add pre-review mechanical checks (10-15 lines)
- Total: ~1 hour of work

## Decision Needed

Which approach should we take?
- **A only**: Cross-family review (simplest)
- **A + C**: Cross-family review + mechanical validation (recommended)
- **B**: Adversarial prompting (no new deps, but may overcorrect)
- **Skip**: Accept the bias, rely on human oversight (existing `needs_review` + checkpoints)
