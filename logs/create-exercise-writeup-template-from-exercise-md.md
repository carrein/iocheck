# Session: Create exercise writeup template from EXERCISE.md

## User

Consider EXERCISE.md. Create a WRITEUP.md that does not answer the questions but is a template that needs to be filled up to fufill ALL requirements listed by the exercise. This should be in MD format. Please ask me if you have questions.

## Assistant

> Bash: ls -la /Users/carrein/Desktop/iocheck2/

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/EXERCISE.md

## Assistant

I have what I need. Two quick clarifications before I write the file, or I can proceed with reasonable defaults:

1. Should I include explicit `<TODO: …>` placeholders inside each section (hints about what evidence/numbers/diagrams to drop in), or keep sections empty?
2. Should the template enforce the "~1-2 pages" constraint by being tight, or include every sub-section even at the cost of length?

I'll proceed with defaults: explicit `<TODO: …>` hints, and comprehensive sub-sections (you can trim when filling). Tell me to adjust if either is wrong.

## Assistant

> Write: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Created `/Users/carrein/Desktop/iocheck2/WRITEUP.md` as a fill-in template covering every requirement in EXERCISE.md:

- Architecture (diagram + justification for language, store, cache, autoscaling signal)
- API surface (all five endpoints)
- All four challenges with explicit evidence prompts
- Failure mode when autoscaler data source is unavailable
- "One thing with another week"
- Appendix for defending dependencies/choices on the call

Each section uses `<TODO: …>` hints rather than answers. Tell me if you want the hints stripped, sections reordered, or anything added (e.g., explicit cost/security sub-sections).
