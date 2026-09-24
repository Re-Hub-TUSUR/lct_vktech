## 2026-09-24T14:57:53Z

<USER_REQUEST>
You are the E2E Test Writer.
Your identity: teamwork_preview_test_writer
Your working directory is: c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/test_writer_e2e
Authoritative user request is located at:
c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/ORIGINAL_REQUEST.md
You MUST read c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/ORIGINAL_REQUEST.md before starting work.
Also read:
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/PROJECT.md
- c:/Programming/Projects/VK_TECH_LCT/lct_vktech/TEST_INFRA.md

Objective:
Create a comprehensive, opaque-box E2E test suite for the Content Package Extensions & Image/Data Pipeline.
Write the test suite in `backend/tests/test_content_package_e2e.py`.

Requirements:
Follow the 4-tier methodology outlined in TEST_INFRA.md:
1. Tier 1 - Feature Coverage:
   - Happy path tests for all 11 features:
     - Upload validation for .png, .jpg, .jpeg, .webp, .svg (assert 201 Created)
     - Upload validation for .json, .yaml, .yml (assert 201 Created)
     - GET /presentations/{id}/files/{file_id}/content returns file with correct MIME type (image/png, image/jpeg, image/webp, image/svg+xml, application/json, application/yaml, etc.) and Cache-Control headers
     - Ingestion extract_text on JSON returns formatted markdown tables and parameters
     - Ingestion extract_text on YAML returns metrics and bulleted lists
     - Ingestion extract_text on images returns metadata (resolution, format) and SVG text
     - Composer binds content package images to image_text slides and title logos
     - PPTX export embeds content images and rasterizes SVG vectors without error
2. Tier 2 - Boundary & Corner Cases:
   - Rejection of invalid file extensions (.exe, .zip, .mp4, .sh) with HTTP 400 and Russian error message
   - Empty files (0 bytes) for image and JSON/YAML
   - Malformed/corrupted JSON and YAML handled gracefully without crashing
   - Files with uppercase or mixed case extensions (.PNG, .Yaml, .SVG)
   - Filenames with unicode, spaces, Cyrillic, and special characters
   - Large structured data files (proper trimming/summarization)
   - Access control (404/403 for non-existent presentation or file)
3. Tier 3 - Cross-Feature Combinations:
   - Upload SVG logo + PNG illustration + YAML metrics together -> verify all extracted and formatted in sources_digest
   - PPTX export with both user_images and content package images
   - PPTX export with SVG image rasterized to PNG
4. Tier 4 - Real-World Application Scenarios:
   - Implement tests for the 6 real-world scenarios defined in TEST_INFRA.md.

Deliverables:
- Implement `backend/tests/test_content_package_e2e.py`.
- Verify tests can be collected by pytest (`pytest --collect-only backend/tests/test_content_package_e2e.py`).
- Create `TEST_READY.md` at project root with runner command, tier breakdown, and feature coverage checklist.
- Write handoff report to `c:/Programming/Projects/VK_TECH_LCT/lct_vktech/.agents/test_writer_e2e/handoff.md`.
- Send completion message to orchestrator.
</USER_REQUEST>
