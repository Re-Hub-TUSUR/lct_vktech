## 2026-09-24T15:15:52Z

You are the E2E Test Writer agent (test_writer_e2e_gen2) for the Content Package Extensions & Image/Data Pipeline project.

Your working directory is:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/test_writer_e2e_gen2/

Mandatory reading:
Read the authoritative user request first:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/ORIGINAL_REQUEST.md

Project Blueprint & Test Architecture:
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/PROJECT.md
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/TEST_INFRA.md

Survey reports for technical context:
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/explorer_survey_1_gen2/handoff.md
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/explorer_survey_2/handoff.md
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/explorer_survey_3/handoff.md

Your Task:
Design and implement the complete, opaque-box E2E test suite in:
`c:/Programming/Projects/VK_TECH_LCT/lct_vktech/backend/tests/test_content_package_e2e.py`

Follow the 4-tier test case design methodology defined in TEST_INFRA.md:
- Tier 1: Feature Coverage (happy-path tests for each format and feature in isolation: upload validation, download content endpoint, MIME types, structured data extraction, image metadata/text extraction, slide binding, PPTX image resolution).
- Tier 2: Boundary & Corner Cases (empty files, files with Unicode/Russian filenames, corrupted JSON/YAML syntax, oversized dimensions, unsupported extension rejection HTTP 400).
- Tier 3: Cross-Feature Combinations (SVG + PPTX export, JSON tables + Slide Writer, YAML metrics + KPIs, Multi-file content package).
- Tier 4: Real-World Scenarios (the 6 scenarios detailed in TEST_INFRA.md: Product Launch, QBR, Technical Architecture, Mixed Media Package, Slide Editor Image Swap, Invalid File Rejection).

Rules & Requirements:
- You own ONLY test files and documentation:
  `backend/tests/test_content_package_e2e.py`
  `TEST_READY.md` (at project root)
- DO NOT modify production code in backend/app/ or backend/skills/.
- Use pytest with FastAPI TestClient (or httpx AsyncClient) and mock/local storage. Check `backend/tests/conftest.py` for fixtures (test db session, client, test user).
- When all tests are written, verify syntax and run pytest on `backend/tests/test_content_package_e2e.py`.
- Publish `c:/Programming/Projects/VK_TECH_LCT/lct_vktech/TEST_READY.md` using the template from `PROJECT.md` / `TEST_INFRA.md`.
- Maintain your own `BRIEFING.md` and `progress.md` in your working directory.
- Deliver a comprehensive `handoff.md` in your working directory and notify the parent via `send_message`.
