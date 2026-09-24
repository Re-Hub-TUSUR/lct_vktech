# E2E Test Infra: Content Package Extensions & Image/Data Pipeline

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation design.
- Derives test cases directly from `ORIGINAL_REQUEST.md` and user-facing contracts.
- Methodology: Category-Partition + Boundary Value Analysis + Pairwise Combinatorial + Real-World Workload Testing.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | Image Upload Validation (.png, .jpg, .jpeg, .webp, .svg) | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 2 | Structured Data Upload Validation (.json, .yaml, .yml) | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 3 | Content File Serving Endpoint (MIME types, caching) | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 4 | Structured Data Parser & Facts Digest | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 5 | Image Content Analysis & OCR/Description | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 6 | Slide Layout Image Binding (`image_text`, logos) | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 7 | PPTX Content Image Resolution & Embedding | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 8 | PPTX SVG Vector Rasterization | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 9 | Frontend Dropzone & Accepted Formats Filter | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 10 | Frontend Category Badges & Image Thumbnails | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |
| 11 | Frontend Slide Editor ImagePickerModal | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |

## Test Architecture
- Test Runner: `pytest` running against FastAPI app or HTTP server.
- Test Files Location: `backend/tests/test_content_package_e2e.py`
- Pass/Fail Semantics: Exit code 0, all assertions pass, HTTP status codes match specification (201 Created, 200 OK, 400 Bad Request for unsupported extensions).

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Product Launch Presentation: Upload company logo (.svg) + product photo (.png) + financial projections (.yaml). Generate presentation, verify logo on title, photo on image_text, financials in digest, and export to PPTX. | F1, F2, F3, F4, F5, F6, F7, F8 | High |
| 2 | Quarterly Business Review (QBR): Upload metrics (.json) + market trends chart (.jpg). Verify JSON KPI metrics extracted into markdown tables, image bound to slide, and PPTX export embeds picture. | F1, F2, F3, F4, F6, F7 | High |
| 3 | Technical Architecture Overview: Upload system spec (.yml) + architecture diagram (.webp). Verify spec parameters extracted into bulleted list, webp diagram embedded in PPTX. | F1, F2, F3, F4, F6, F7 | Medium |
| 4 | Mixed Media Package: Upload 5 mixed files (.png, .jpeg, .svg, .json, .yaml) along with existing .pdf and .docx. Verify all succeed, correct category badges / MIME types, and digest length limits respected. | F1, F2, F3, F4, F9, F10 | High |
| 5 | Slide Editor Image Swap: Manually replace a placeholder image with a content package uploaded logo in the slide editor, verify patch persists and PPTX export includes the updated logo. | F3, F6, F7, F8, F11 | Medium |
| 6 | Invalid File Rejection: Attempt uploading unsupported formats (.exe, .mp4, .zip). Verify HTTP 400 rejection and Russian error message with allowed format list. | F1, F2, F9 | Low |

## Coverage Thresholds
- Tier 1: >=5 test cases per feature (happy-path isolated feature tests)
- Tier 2: >=5 test cases per feature (boundary values, empty files, huge files, corrupted syntax, edge extensions)
- Tier 3: Pairwise coverage of feature combinations (e.g. SVG + PPTX, JSON tables + Writer, YAML + VLM)
- Tier 4: >=6 real-world end-to-end scenarios
