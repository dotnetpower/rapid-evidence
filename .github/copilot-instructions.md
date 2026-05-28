You are building a Python 3.11+ library called `rapid_evidence`: a policy-governed
burst evidence collection toolkit for public-health / research crisis use cases. It
must be reimplemented from scratch under `rapid_evidence/` with its own
`pyproject.toml`, `tests/`, `benchmarks/`, and `README.md`. Follow every invariant
below — they are not suggestions.

================================================================
DESIGN PHILOSOPHY (non-negotiable)
================================================================

1.  Managed collection, NOT rate-limit evasion.
    Sources must register a SourcePolicy (concurrency, min_delay_seconds, batch
    size, required headers, retry attempts, allowed methods). The scheduler MUST
    refuse to enqueue or dispatch work for a source that has no policy.

2.  Swappable components.
    Queue, storage sink, worker provider, audit sink are Protocols. The library
    ships an in-memory queue, a filesystem sink, a local provider, an in-memory
    Spot VM provider (for tests), and an Azure CLI backed Spot VM provider. The
    scheduler must not import any of them concretely except through DI.

3.  Bounded micro-batches.
    Workers pull bounded chunks via `dequeue_batch(source, n)`. The queue MUST
    cap `max_queued` and reject overflow with `QueueCapacityError`.

4.  Safety defaults at every boundary.
    - URL guard validates that every fetched URL is HTTPS, resolves to a
      *global* (non-private, non-loopback, non-link-local, non-multicast,
      non-reserved) IP, AND re-validates after every redirect using a
      `GuardedHTTPTransport`.
    - `httpx.Client.stream()` with bounded `iter_bytes()` capture so a huge
      response cannot exhaust memory before truncation.
    - Result files written with mode 0600 inside a 0700 directory + fsync.
    - Worker dequeues must `requeue_front` on sink write failure (no lost work).
    - In-memory dedupe set MUST release keys on dequeue, never grow unbounded.

5.  Measurable, never fake-success.
    Every long-running operation surfaces a numeric metric (count, seconds,
    bytes, p95). "STARTED" alone is not progress.

6.  Critical-0 hardening loop (MANDATORY post-coding self-review).
    After every code change — before declaring the task done — perform a
    severity-ordered self-critique that produces **at least 10 distinct findings**
    sorted Critical → High → Medium → Low. Iterate fixes until **only Low (or
    Info) findings remain**; Critical and High must be 0. Record every round in
    `HARDENING_REVIEW.md` with: finding, severity, root cause, fix, and the
    file/commit where the fix landed. A change is not "done" while any High or
    Critical is open, even if tests pass.

7.  Single Responsibility Principle (file-size discipline).
    Each module owns one concept; files must not grow unbounded. Hard limits,
    enforced during the hardening review:
    - Source files target ≤ 250 lines; **300 lines is the hard ceiling**.
      When a file approaches the ceiling, split by responsibility (e.g. a
      scheduler module separates `planner`, `dispatcher`, `lease_tracker`)
      rather than appending more code.
    - One public class or one cohesive function family per file. Helpers used
      by exactly one caller stay private; helpers shared across modules move
      to a sibling module, never to a god-module.
    - Tests mirror the production layout: `tests/test_<module>.py` per source
      module. Do not pile unrelated assertions into one mega-test file.
    - Pure-move refactors (no behaviour change) are encouraged and must keep
      the package `__init__.py` public exports stable.

8.  Step-back-first, correctness over speed.
    Before writing code, pause to identify bottlenecks, contention points, and
    failure modes (lock scope, unbounded growth, sync I/O on hot paths, N+1
    network calls, blocking calls inside async, GIL hot loops). Prefer a
    slower, correct, well-reviewed implementation over a fast first draft that
    requires rework. Concretely:
    - Identify the hot path and its worst-case input size before choosing a
      data structure.
    - Any new lock, queue, or shared mutable state must declare its bound and
      its eviction / back-pressure rule in the code or a one-line comment.
    - No "we'll optimize later" placeholders that allocate unbounded memory,
      open unbounded connections, or spawn unbounded tasks.
    - If a design choice has more than one plausible answer, write a 2–4 line
      trade-off note in the PR description (not the code).
    - When in doubt, step back, sketch the data flow, and reread the relevant
      Design Philosophy items before typing.

================================================================
CODE MAP (source of truth for module layout)
================================================================

The authoritative inventory of source modules, public exports, line counts,
and SRP debt lives in [`docs/CODEMAP.md`](../docs/CODEMAP.md). Read it before
adding a new file, splitting an oversized one, or wiring a new public symbol
into `src/rapid_evidence/__init__.py`. Update `docs/CODEMAP.md` in the same
change that adds, removes, splits, or renames a module — the codemap is part
of the change, not a follow-up.

Hard rules that come from the codemap:
- Files above the 300-line ceiling listed in the codemap MUST be split before
  more behaviour is added to them.
- Any new public name added to `rapid_evidence/__init__.py` must appear in
  the codemap with its owning module.
- Tests mirror the source layout (`tests/test_<module>.py`); when you split a
  source module, split its test file the same way.
