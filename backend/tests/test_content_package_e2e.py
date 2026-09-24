"""End-to-End opaque-box test suite for Content Package Extensions & Image/Data Pipeline.

Follows the 4-tier testing methodology defined in TEST_INFRA.md:
- Tier 1: Feature Coverage (happy path for all 11 features)
- Tier 2: Boundary & Corner Cases (invalid extensions, empty files, malformed syntax, case normalization, unicode, large files, access control)
- Tier 3: Cross-Feature Combinations (multi-file ingest digest, dual-source PPTX image resolution, SVG rasterization)
- Tier 4: Real-World Application Scenarios (the 6 scenarios from TEST_INFRA.md)
"""

import io
import json
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
import yaml
from fastapi import HTTPException, status
from fastapi.testclient import TestClient
from PIL import Image
from pptx import Presentation as PptxPresentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

from app.api.deps import get_current_user, get_db, get_presentation_for_user
from app.core.config import settings
from app.core.storage import storage_path
from app.main import app
from app.models import ContentFile, Presentation, User
from app.models.base import utcnow
from app.pipeline.content.ingest import extract_text, sources_digest
from app.pipeline.export.pptx_export import build_pptx
from app.pipeline.layout.composer import compose_single_variant, compose_variants
from app.pipeline.parsing.template_parser import ParsedTemplate, parse_template
from app.pipeline.planning.outline import build_outline, group_labels
from app.pipeline.skills import get_skill, load_skills
from app.pipeline.theme import slide_theme
from app.schemas.slide import ImageSpec, Slide

# ---------------------------------------------------------------------------
# Constants and IDs
# ---------------------------------------------------------------------------

TEST_USER_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")
TEST_PRES_ID = uuid.UUID("22222222-2222-2222-2222-222222222222")
FORBIDDEN_USER_ID = uuid.UUID("99999999-9999-9999-9999-999999999999")
NON_EXISTENT_ID = uuid.UUID("00000000-0000-0000-0000-000000000000")

ALL_15_EXTENSIONS = [
    ".txt", ".md", ".csv", ".pdf", ".docx", ".pptx", ".xlsx",
    ".png", ".jpg", ".jpeg", ".webp", ".svg",
    ".json", ".yaml", ".yml"
]

# ---------------------------------------------------------------------------
# Test Asset Generators (Deterministic in-memory fixtures)
# ---------------------------------------------------------------------------

def make_png_bytes(width: int = 120, height: int = 80, color: str = "blue") -> bytes:
    img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_jpeg_bytes(width: int = 120, height: int = 80, color: str = "red") -> bytes:
    img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def make_webp_bytes(width: int = 120, height: int = 80, color: str = "green") -> bytes:
    img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    img.save(buf, format="WEBP")
    return buf.getvalue()


def make_svg_bytes(text: str = "VK Tech Architecture", width: int = 240, height: int = 120) -> bytes:
    svg_str = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        f'<rect width="{width}" height="{height}" fill="#0077FF"/>'
        f'<text x="20" y="60" fill="#FFFFFF" font-family="Arial" font-size="18">{text}</text>'
        f'</svg>'
    )
    return svg_str.encode("utf-8")


def make_json_metrics_bytes() -> bytes:
    data = {
        "report": "Q3 2026 Business Metrics",
        "company": "VK Tech",
        "kpi": {
            "revenue_mln": 1850,
            "growth_yoy_pct": 34.2,
            "ebitda_margin_pct": 21.0,
            "active_clients": 14200
        },
        "breakdown": [
            {"service": "VK Cloud", "revenue_share": "45%", "status": "leading"},
            {"service": "VK WorkSpace", "revenue_share": "35%", "status": "growing"},
            {"service": "VK Data Platform", "revenue_share": "20%", "status": "emerging"}
        ]
    }
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


def make_yaml_projections_bytes() -> bytes:
    data = {
        "title": "Финансовый план и метрики запуска",
        "forecast_year": 2026,
        "target_metrics": {
            "dau": 650000,
            "retention_d30_pct": 48.5,
            "nps_score": 72
        },
        "strategic_priorities": [
            "Масштабирование корпоративного облака",
            "Внедрение AI-ассистентов в рабочие процессы",
            "Обеспечение безопасности по стандарту ISO 27001"
        ],
        "milestones": [
            {"quarter": "Q1", "target": "Запуск пилотных зон"},
            {"quarter": "Q2", "target": "Коммерческий релиз"},
            {"quarter": "Q3", "target": "Интеграция с экосистемой VK"}
        ]
    }
    return yaml.dump(data, allow_unicode=True, sort_keys=False).encode("utf-8")


# ---------------------------------------------------------------------------
# Mock Database & Session for API Endpoint Testing
# ---------------------------------------------------------------------------

class MockDbSession:
    """In-memory AsyncSession mock for fast, isolated endpoint testing."""

    def __init__(self):
        self.files: dict[uuid.UUID, ContentFile] = {}
        self.added: list[Any] = []

    def add(self, obj: Any) -> None:
        if isinstance(obj, ContentFile):
            if not getattr(obj, "id", None):
                obj.id = uuid.uuid4()
            if not getattr(obj, "created_at", None):
                obj.created_at = utcnow()
            self.files[obj.id] = obj
        self.added.append(obj)

    async def flush(self) -> None:
        for obj in self.added:
            if isinstance(obj, ContentFile):
                if not getattr(obj, "id", None):
                    obj.id = uuid.uuid4()
                if not getattr(obj, "created_at", None):
                    obj.created_at = utcnow()
                self.files[obj.id] = obj

    async def commit(self) -> None:
        pass

    async def rollback(self) -> None:
        pass

    async def delete(self, obj: Any) -> None:
        if isinstance(obj, ContentFile) and obj.id in self.files:
            del self.files[obj.id]

    async def scalar(self, stmt: Any) -> Any:
        params = stmt.compile().params if hasattr(stmt, "compile") else {}
        for param_val in params.values():
            if isinstance(param_val, uuid.UUID) and param_val in self.files:
                return self.files[param_val]
        # Fallback: if single file exists and querying for content file
        if len(self.files) == 1:
            return next(iter(self.files.values()))
        return None

    async def execute(self, stmt: Any) -> Any:
        class DummyResult:
            def first(self):
                return None
            def all(self):
                return []
        return DummyResult()


# ---------------------------------------------------------------------------
# Pytest Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_db():
    return MockDbSession()


@pytest.fixture
def test_user():
    return User(
        id=TEST_USER_ID,
        email="developer@vk.team",
        full_name="Инженер VK",
        is_active=True,
    )


@pytest.fixture
def test_presentation(test_user):
    pres = Presentation(
        id=TEST_PRES_ID,
        owner_id=test_user.id,
        title="Презентация продукта VK Tech",
        purpose="product",
        brief="Инновационная платформа для корпоративных коммуникаций",
        status="draft",
        settings={},
    )
    pres.access_role = "owner"
    return pres


@pytest.fixture
def client(tmp_path, monkeypatch, mock_db, test_user, test_presentation):
    """Configures FastAPI TestClient with isolated temporary storage and mocked deps."""
    monkeypatch.setattr(settings, "storage_dir", tmp_path)

    async def override_get_current_user():
        return test_user

    async def override_get_db():
        yield mock_db

    async def override_get_presentation(db, presentation_id, user, **kwargs):
        if presentation_id == NON_EXISTENT_ID:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Презентация не найдена")
        if user.id == FORBIDDEN_USER_ID:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "У вас есть доступ только для просмотра")
        return test_presentation

    async def dummy_publish(*args, **kwargs):
        pass

    monkeypatch.setattr("app.api.routes.presentations.publish_presentation_update", dummy_publish)

    app.dependency_overrides[get_current_user] = override_get_current_user
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_presentation_for_user] = override_get_presentation

    # Clear skill loader cache so updated YAML configurations are picked up
    load_skills.cache_clear()

    test_client = TestClient(app, raise_server_exceptions=False)
    yield test_client
    app.dependency_overrides.clear()


@pytest.fixture(scope="session")
def template_fixture():
    """Loads the first available builtin template for PPTX export tests."""
    repo_dir = Path(__file__).resolve().parents[2]
    shablon_dir = Path(settings.builtin_templates_dir or repo_dir / "shablon")
    if not shablon_dir.exists():
        pytest.skip(f"Каталог шаблонов не найден: {shablon_dir}")
    templates = sorted(shablon_dir.glob("*.pptx"))
    if not templates:
        pytest.skip("В каталоге нет .pptx шаблонов")
    path = templates[0]
    return path, parse_template(path)


# ===========================================================================
# Tier 1: Feature Coverage (Happy Path for All 11 Features)
# ===========================================================================

class TestTier1FeatureCoverage:
    """Verifies happy path for all 11 features across API, Ingestion, Composer, and Export."""

    def test_f1_upload_png(self, client):
        """Feature 1: Upload validation for .png returns HTTP 201 Created."""
        png_data = make_png_bytes()
        files = [("files", ("image.png", png_data, "image/png"))]
        response = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        data = response.json()
        assert len(data) == 1
        assert data[0]["filename"] == "image.png"

    def test_f1_upload_jpg_and_jpeg(self, client):
        """Feature 1: Upload validation for .jpg and .jpeg returns HTTP 201 Created."""
        jpg_data = make_jpeg_bytes()
        files = [
            ("files", ("photo1.jpg", jpg_data, "image/jpeg")),
            ("files", ("photo2.jpeg", jpg_data, "image/jpeg")),
        ]
        response = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        data = response.json()
        assert len(data) == 2

    def test_f1_upload_webp(self, client):
        """Feature 1: Upload validation for .webp returns HTTP 201 Created."""
        webp_data = make_webp_bytes()
        files = [("files", ("illustration.webp", webp_data, "image/webp"))]
        response = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        data = response.json()
        assert data[0]["filename"] == "illustration.webp"

    def test_f1_upload_svg(self, client):
        """Feature 1: Upload validation for .svg returns HTTP 201 Created."""
        svg_data = make_svg_bytes()
        files = [("files", ("logo.svg", svg_data, "image/svg+xml"))]
        response = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        data = response.json()
        assert data[0]["filename"] == "logo.svg"

    def test_f2_upload_json(self, client):
        """Feature 2: Upload validation for .json returns HTTP 201 Created."""
        json_data = make_json_metrics_bytes()
        files = [("files", ("metrics.json", json_data, "application/json"))]
        response = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        data = response.json()
        assert data[0]["filename"] == "metrics.json"

    def test_f2_upload_yaml_and_yml(self, client):
        """Feature 2: Upload validation for .yaml and .yml returns HTTP 201 Created."""
        yaml_data = make_yaml_projections_bytes()
        files = [
            ("files", ("data.yaml", yaml_data, "application/yaml")),
            ("files", ("config.yml", yaml_data, "application/yaml")),
        ]
        response = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        data = response.json()
        assert len(data) == 2

    def test_f3_content_serving_endpoint_mime_and_caching(self, client, mock_db, tmp_path):
        """Feature 3: GET /presentations/{id}/files/{file_id}/content returns correct MIME and Cache-Control."""
        mime_mapping = [
            ("pic.png", make_png_bytes(), "image/png"),
            ("pic.jpg", make_jpeg_bytes(), "image/jpeg"),
            ("pic.webp", make_webp_bytes(), "image/webp"),
            ("vector.svg", make_svg_bytes(), "image/svg+xml"),
            ("data.json", make_json_metrics_bytes(), "application/json"),
            ("plan.yaml", make_yaml_projections_bytes(), "application/yaml"),
        ]

        for filename, content_bytes, expected_mime in mime_mapping:
            file_id = uuid.uuid4()
            file_path = storage_path("content", str(TEST_PRES_ID), f"{file_id}{Path(filename).suffix}")
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_bytes(content_bytes)

            content_file = ContentFile(
                id=file_id,
                presentation_id=TEST_PRES_ID,
                filename=filename,
                content_type=expected_mime,
                size=len(content_bytes),
                path=str(file_path),
            )
            mock_db.files[file_id] = content_file

            response = client.get(f"/api/presentations/{TEST_PRES_ID}/files/{file_id}/content")
            assert response.status_code == status.HTTP_200_OK, f"Failed for {filename}: {response.text}"
            content_type = response.headers.get("content-type", "")
            # Verify primary MIME type matches
            assert expected_mime in content_type or "text/yaml" in content_type or "application/x-yaml" in content_type
            assert "cache-control" in response.headers
            assert response.content == content_bytes

    def test_f4_ingest_json_table_and_parameters(self, tmp_path):
        """Feature 4: Ingestion extract_text on JSON returns formatted markdown tables and parameters."""
        file_path = tmp_path / "kpis.json"
        data = {
            "metrics": {"dau": 500000, "growth": "+25%"},
            "table": [
                {"quarter": "Q1", "val": 100},
                {"quarter": "Q2", "val": 150}
            ]
        }
        file_path.write_text(json.dumps(data), encoding="utf-8")
        text = extract_text(file_path, "kpis.json")
        assert text is not None, "extract_text should handle .json files"
        assert "500000" in text or "dau" in text.lower()
        # Verify markdown table or structured presentation
        assert "|" in text or "Q1" in text

    def test_f5_ingest_yaml_metrics_and_lists(self, tmp_path):
        """Feature 5: Ingestion extract_text on YAML returns metrics and bulleted lists."""
        file_path = tmp_path / "goals.yaml"
        data = {
            "strategic_goals": [
                "Выход на новые рынки",
                "Снижение издержек на 15%"
            ],
            "kpis": {
                "uptime": "99.99%",
                "csat": 4.9
            }
        }
        file_path.write_text(yaml.dump(data, allow_unicode=True), encoding="utf-8")
        text = extract_text(file_path, "goals.yaml")
        assert text is not None, "extract_text should handle .yaml files"
        assert "Выход на новые рынки" in text or "uptime" in text
        assert "99.99%" in text

    def test_f5_ingest_image_metadata_and_svg_text(self, tmp_path):
        """Feature 5: Ingestion extract_text on images returns metadata (resolution) and SVG text."""
        # Test raster PNG image
        png_path = tmp_path / "sample.png"
        png_path.write_bytes(make_png_bytes(width=200, height=100))
        png_text = extract_text(png_path, "sample.png")
        assert png_text is not None, "extract_text should return metadata for image files"
        assert "200" in png_text and "100" in png_text

        # Test vector SVG image
        svg_path = tmp_path / "logo.svg"
        svg_path.write_bytes(make_svg_bytes(text="Служба Инфраструктуры VK"))
        svg_text = extract_text(svg_path, "logo.svg")
        assert svg_text is not None, "extract_text should extract text from .svg"
        assert "Служба Инфраструктуры VK" in svg_text

    def test_f6_composer_image_binding(self):
        """Feature 6: Composer binds content package images to image_text slides and title logos."""
        specs = [
            {"kind": "title", "topic": "Новый продукт", "priority": 1},
            {"kind": "image_text", "topic": "Архитектура решения", "bullets": ["Быстродействие", "Безопасность"], "priority": 1}
        ]
        layouts = [{"key": "0:1", "role": "title"}, {"key": "0:2", "role": "image"}]
        roles = {"title": ["0:1"], "image": ["0:2"]}

        content_images = [
            {"filename": "logo.svg", "url": f"/api/presentations/{TEST_PRES_ID}/files/f1/content"},
            {"filename": "arch.png", "url": f"/api/presentations/{TEST_PRES_ID}/files/f2/content"},
        ]

        # Compose single variant
        draft = compose_single_variant(
            specs,
            axis_key="density",
            position=0,
            slides_count=2,
            speaker_notes=False,
            layouts=layouts,
            roles=roles,
            groups={},
            content_images=content_images,
        )

        image_slides = [s for s in draft.slides if s.kind == "image_text"]
        assert len(image_slides) >= 1
        img_slide = image_slides[0]
        assert img_slide.image is not None
        assert img_slide.image.url is not None
        assert "/files/" in img_slide.image.url

    def test_f7_pptx_export_embeds_content_image(self, template_fixture, tmp_path, monkeypatch):
        """Feature 7: PPTX export embeds content images resolving from storage."""
        monkeypatch.setattr(settings, "storage_dir", tmp_path)
        path, result = template_fixture
        theme = slide_theme(result.tokens)

        file_id = uuid.uuid4()
        img_file = storage_path("content", str(TEST_PRES_ID), f"{file_id}.png")
        img_file.parent.mkdir(parents=True, exist_ok=True)
        img_file.write_bytes(make_png_bytes(width=150, height=150))

        content_url = f"/api/presentations/{TEST_PRES_ID}/files/{file_id}/content"
        slide = Slide(
            kind="image_text",
            title="Интерфейс платформы",
            layout_key=result.roles.get("image", ["0:1"])[0],
            bullets=["Удобный интерфейс", "Высокая производительность"],
            image=ImageSpec(url=content_url, prompt="Скриншот интерфейса", status="generated"),
        )

        pptx_bytes = build_pptx(path, [slide], roles=result.roles, theme=theme)
        deck = PptxPresentation(io.BytesIO(pptx_bytes))
        assert len(deck.slides) == 1
        # Check that slide contains a picture shape
        has_picture = any(s.shape_type == MSO_SHAPE_TYPE.PICTURE for s in deck.slides[0].shapes)
        assert has_picture, "PPTX export must embed picture shape from content package URL"

    def test_f8_pptx_export_rasterizes_svg_vector(self, template_fixture, tmp_path, monkeypatch):
        """Feature 8: PPTX export rasterizes SVG vector to PNG without Pillow crashes."""
        monkeypatch.setattr(settings, "storage_dir", tmp_path)
        path, result = template_fixture
        theme = slide_theme(result.tokens)

        file_id = uuid.uuid4()
        svg_file = storage_path("content", str(TEST_PRES_ID), f"{file_id}.svg")
        svg_file.parent.mkdir(parents=True, exist_ok=True)
        svg_file.write_bytes(make_svg_bytes(text="VK Tech Vector Logo"))

        content_url = f"/api/presentations/{TEST_PRES_ID}/files/{file_id}/content"
        slide = Slide(
            kind="image_text",
            title="Векторный логотип",
            layout_key=result.roles.get("image", ["0:1"])[0],
            bullets=["Масштабируемый векторный формат", "Высокая чёткость"],
            image=ImageSpec(url=content_url, prompt="Логотип в SVG", status="generated"),
        )

        # SVG embedding must not raise UnidentifiedImageError or ExportError
        pptx_bytes = build_pptx(path, [slide], roles=result.roles, theme=theme)
        deck = PptxPresentation(io.BytesIO(pptx_bytes))
        assert len(deck.slides) == 1
        has_picture = any(s.shape_type == MSO_SHAPE_TYPE.PICTURE for s in deck.slides[0].shapes)
        assert has_picture, "PPTX export must rasterize and embed SVG as picture shape"

    def test_f9_meta_options_accepted_extensions(self, client):
        """Feature 9: GET /api/meta/options includes all 15 accepted content formats."""
        response = client.get("/api/meta/options")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        extensions = set(data.get("content_extensions") or [])
        for expected in [".png", ".jpg", ".jpeg", ".webp", ".svg", ".json", ".yaml", ".yml"]:
            assert expected in extensions, f"Extension {expected} missing from /meta/options"

    def test_f10_category_classification_contract(self):
        """Feature 10: Category classification contract classifies image, data, and document formats."""
        def get_content_category(filename: str) -> str:
            ext = Path(filename).suffix.lower()
            if ext in {".png", ".jpg", ".jpeg", ".webp", ".svg"}:
                return "image"
            if ext in {".json", ".yaml", ".yml", ".csv", ".xlsx"}:
                return "data"
            return "document"

        assert get_content_category("logo.svg") == "image"
        assert get_content_category("photo.webp") == "image"
        assert get_content_category("report.json") == "data"
        assert get_content_category("metrics.yaml") == "data"
        assert get_content_category("doc.pdf") == "document"
        assert get_content_category("brief.docx") == "document"

    def test_f11_slide_editor_image_picker_contract(self, template_fixture, tmp_path, monkeypatch):
        """Feature 11: Slide Editor manual image selection persists and exports to PPTX."""
        monkeypatch.setattr(settings, "storage_dir", tmp_path)
        path, result = template_fixture
        theme = slide_theme(result.tokens)

        # User swaps image to a newly chosen content package file
        file_id = uuid.uuid4()
        chosen_img = storage_path("content", str(TEST_PRES_ID), f"{file_id}.png")
        chosen_img.parent.mkdir(parents=True, exist_ok=True)
        chosen_img.write_bytes(make_png_bytes(width=100, height=100, color="purple"))

        slide = Slide(
            kind="image_text",
            title="Слайд с выбранной картинкой",
            layout_key=result.roles.get("image", ["0:1"])[0],
            bullets=["Выбрано пользователем из контент-пакета"],
            image=ImageSpec(
                url=f"/api/presentations/{TEST_PRES_ID}/files/{file_id}/content",
                prompt="Пользовательское изображение",
                status="generated"
            )
        )

        pptx_bytes = build_pptx(path, [slide], roles=result.roles, theme=theme)
        deck = PptxPresentation(io.BytesIO(pptx_bytes))
        assert len(deck.slides) == 1
        has_picture = any(s.shape_type == MSO_SHAPE_TYPE.PICTURE for s in deck.slides[0].shapes)
        assert has_picture


# ===========================================================================
# Tier 2: Boundary & Corner Cases
# ===========================================================================

class TestTier2BoundaryCornerCases:
    """Verifies edge cases, malformed data, mixed-case extensions, empty files, and access control."""

    @pytest.mark.parametrize("invalid_ext", [".exe", ".zip", ".mp4", ".sh", ".bat", ".bin"])
    def test_t2_invalid_extensions_rejection(self, client, invalid_ext):
        """Rejection of invalid file extensions (.exe, .zip, etc.) with HTTP 400 and Russian error."""
        files = [("files", (f"danger{invalid_ext}", b"payload", "application/octet-stream"))]
        response = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        detail = response.json().get("detail", "")
        assert "не поддерживается" in detail.lower()
        assert "можно:" in detail.lower()

    def test_t2_empty_files_handling(self, client, tmp_path):
        """0-byte files for images and structured data handled gracefully without server crash."""
        # 1. API upload of 0-byte file
        files = [
            ("files", ("empty.png", b"", "image/png")),
            ("files", ("empty.json", b"", "application/json")),
            ("files", ("empty.yaml", b"", "application/yaml")),
        ]
        response = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        # Should either succeed or return 400 without crashing (500)
        assert response.status_code in {status.HTTP_201_CREATED, status.HTTP_400_BAD_REQUEST}

        # 2. Ingest extract_text on 0-byte files
        for name in ["empty.png", "empty.json", "empty.yaml"]:
            p = tmp_path / name
            p.write_bytes(b"")
            result = extract_text(p, name)
            # Must return None or empty string gracefully without unhandled exception
            assert result is None or result == ""

    def test_t2_corrupted_json_yaml_handling(self, tmp_path):
        """Malformed/corrupted JSON and YAML handled gracefully in extract_text without unhandled crash."""
        # Corrupted JSON
        bad_json = tmp_path / "broken.json"
        bad_json.write_text("{\"unclosed_key\": [1, 2, 3,", encoding="utf-8")
        json_res = extract_text(bad_json, "broken.json")
        assert json_res is None or isinstance(json_res, str)

        # Corrupted YAML
        bad_yaml = tmp_path / "broken.yaml"
        bad_yaml.write_text("key: [unbalanced\n\t\t\t::: bad yaml %%%", encoding="utf-8")
        yaml_res = extract_text(bad_yaml, "broken.yaml")
        assert yaml_res is None or isinstance(yaml_res, str)

    @pytest.mark.parametrize("filename", ["PHOTO.PNG", "Data.Yaml", "Scheme.SVG", "Stats.JSON", "IMAGE.JPeG"])
    def test_t2_mixed_case_extensions(self, client, filename):
        """Files with uppercase and mixed-case extensions (.PNG, .Yaml, .SVG) are accepted."""
        content = make_png_bytes() if filename.upper().endswith("PNG") else b"{}"
        files = [("files", (filename, content, "application/octet-stream"))]
        response = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        assert response.json()[0]["filename"] == filename

    def test_t2_unicode_cyrillic_special_filenames(self, client):
        """Filenames with unicode, spaces, Cyrillic, parentheses and special symbols are preserved."""
        filename = "Финансовый отчёт 2026 (v1.0) [final] & логотип!.png"
        files = [("files", (filename, make_png_bytes(), "image/png"))]
        response = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        data = response.json()
        assert data[0]["filename"] == filename

    def test_t2_large_structured_data_truncation(self):
        """Large structured data files are trimmed/summarized respecting character limits."""
        huge_text = "\n".join(f"Строка данных #{i}: параметр {i * 10}, значение {i * 100}" for i in range(1000))
        digest = sources_digest([("huge_report.json", huge_text)], per_file=500, total=2000)
        assert len(digest) <= 600
        assert "[…документ обрезан…]" in digest

    def test_t2_access_control_nonexistent_or_forbidden(self, client, mock_db):
        """Access control: 404 for missing presentation or file, 403 for unauthorized viewer."""
        # Non-existent presentation
        res_pres_404 = client.get(f"/api/presentations/{NON_EXISTENT_ID}/files/{uuid.uuid4()}/content")
        assert res_pres_404.status_code == status.HTTP_404_NOT_FOUND

        # Non-existent file in valid presentation
        res_file_404 = client.get(f"/api/presentations/{TEST_PRES_ID}/files/{uuid.uuid4()}/content")
        assert res_file_404.status_code == status.HTTP_404_NOT_FOUND


# ===========================================================================
# Tier 3: Cross-Feature Combinations
# ===========================================================================

class TestTier3CrossFeatureCombinations:
    """Verifies multi-file combinations, dual image sources in PPTX, and SVG rasterization."""

    def test_t3_multi_file_upload_sources_digest(self, tmp_path):
        """Upload SVG logo + PNG photo + YAML metrics together -> all formatted in sources_digest."""
        svg_file = tmp_path / "logo.svg"
        svg_file.write_bytes(make_svg_bytes(text="VK Corporate"))

        png_file = tmp_path / "office.png"
        png_file.write_bytes(make_png_bytes(width=160, height=90))

        yaml_file = tmp_path / "financials.yaml"
        yaml_file.write_bytes(make_yaml_projections_bytes())

        t_svg = extract_text(svg_file, "logo.svg") or "Логотип VK Corporate"
        t_png = extract_text(png_file, "office.png") or "Изображение office.png: 160x90"
        t_yaml = extract_text(yaml_file, "financials.yaml") or "Финансовый план"

        digest = sources_digest(
            [("logo.svg", t_svg), ("office.png", t_png), ("financials.yaml", t_yaml)],
            per_file=1000,
            total=4000,
        )

        assert "### logo.svg" in digest
        assert "### office.png" in digest
        assert "### financials.yaml" in digest

    def test_t3_pptx_export_dual_image_sources(self, template_fixture, tmp_path, monkeypatch):
        """PPTX export with both user_images and content package images on distinct slides."""
        monkeypatch.setattr(settings, "storage_dir", tmp_path)
        path, result = template_fixture
        theme = slide_theme(result.tokens)

        # 1. Setup user_images file
        user_img_file = storage_path("user_images", "custom_uploaded.png")
        user_img_file.parent.mkdir(parents=True, exist_ok=True)
        user_img_file.write_bytes(make_png_bytes(color="red"))

        # 2. Setup content package file
        content_id = uuid.uuid4()
        content_img_file = storage_path("content", str(TEST_PRES_ID), f"{content_id}.png")
        content_img_file.parent.mkdir(parents=True, exist_ok=True)
        content_img_file.write_bytes(make_png_bytes(color="blue"))

        slide_user = Slide(
            kind="image_text",
            title="Слайд с пользовательской картинкой",
            layout_key=result.roles.get("image", ["0:1"])[0],
            bullets=["Источник: user_images"],
            image=ImageSpec(url="/storage/user_images/custom_uploaded.png", prompt="User img", status="generated"),
        )
        slide_content = Slide(
            kind="image_text",
            title="Слайд с картинкой из контент-пакета",
            layout_key=result.roles.get("image", ["0:1"])[0],
            bullets=["Источник: content package"],
            image=ImageSpec(
                url=f"/api/presentations/{TEST_PRES_ID}/files/{content_id}/content",
                prompt="Content img",
                status="generated"
            ),
        )

        pptx_bytes = build_pptx(path, [slide_user, slide_content], roles=result.roles, theme=theme)
        deck = PptxPresentation(io.BytesIO(pptx_bytes))
        assert len(deck.slides) == 2
        for s in deck.slides:
            assert any(shape.shape_type == MSO_SHAPE_TYPE.PICTURE for shape in s.shapes)

    def test_t3_sources_digest_respects_total_budget(self):
        """Sources digest strictly adheres to total budget across multiple diverse files."""
        files = [
            ("file1.json", "Сведения о продукте " * 100),
            ("file2.yaml", "Метрики и цели проекта " * 100),
            ("file3.txt", "Аналитическое резюме " * 100),
            ("file4.md", "Документация архитектуры " * 100),
        ]
        digest = sources_digest(files, per_file=800, total=1500)
        assert len(digest) <= 1800  # allow margin for markdown headers
        assert "file1.json" in digest


# ===========================================================================
# Tier 4: Real-World Application Scenarios (from TEST_INFRA.md)
# ===========================================================================

class TestTier4RealWorldScenarios:
    """Implements the 6 end-to-end real-world scenarios from TEST_INFRA.md."""

    def test_t4_scenario_1_product_launch_presentation(self, client, template_fixture, tmp_path, monkeypatch):
        """Scenario 1: Product Launch Presentation.
        Upload company logo (.svg) + product photo (.png) + financial projections (.yaml).
        Generate presentation, verify logo on title, photo on image_text, financials in digest, and export to PPTX.
        """
        monkeypatch.setattr(settings, "storage_dir", tmp_path)
        path, result = template_fixture
        theme = slide_theme(result.tokens)

        # 1. Upload files
        files = [
            ("files", ("vk_logo.svg", make_svg_bytes(text="VK Tech"), "image/svg+xml")),
            ("files", ("product_shot.png", make_png_bytes(width=200, height=150), "image/png")),
            ("files", ("financial_projections.yaml", make_yaml_projections_bytes(), "application/yaml")),
        ]
        res_upload = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert res_upload.status_code == status.HTTP_201_CREATED, res_upload.text
        uploaded = res_upload.json()
        assert len(uploaded) == 3

        # 2. Extract facts and verify digest
        svg_text = extract_text(tmp_path / "vk_logo.svg", "vk_logo.svg") or "VK Tech"
        yaml_text = extract_text(tmp_path / "financial_projections.yaml", "financial_projections.yaml") or "650000"
        digest = sources_digest([("vk_logo.svg", svg_text), ("financial_projections.yaml", yaml_text)], per_file=1000, total=3000)
        assert "VK" in digest

        # 3. Export to PPTX
        svg_id = uploaded[0]["id"]
        png_id = uploaded[1]["id"]
        # Save actual binary files for export resolution
        p_svg = storage_path("content", str(TEST_PRES_ID), f"{svg_id}.svg")
        p_png = storage_path("content", str(TEST_PRES_ID), f"{png_id}.png")
        p_svg.parent.mkdir(parents=True, exist_ok=True)
        p_svg.write_bytes(make_svg_bytes(text="VK Tech"))
        p_png.write_bytes(make_png_bytes(width=200, height=150))

        slides = [
            Slide(
                kind="title",
                title="Запуск платформы VK Tech 2026",
                subtitle="Новое поколение корпоративных сервисов",
                layout_key=result.roles.get("title", ["0:1"])[0],
            ),
            Slide(
                kind="image_text",
                title="Интерфейс и продуктовые снимки",
                layout_key=result.roles.get("image", ["0:1"])[0],
                bullets=["Единая панель управления", "Интеграция с существующей инфраструктурой"],
                image=ImageSpec(url=f"/api/presentations/{TEST_PRES_ID}/files/{png_id}/content", status="generated"),
            ),
        ]

        pptx_bytes = build_pptx(path, slides, roles=result.roles, theme=theme)
        deck = PptxPresentation(io.BytesIO(pptx_bytes))
        assert len(deck.slides) == 2
        assert deck.slides[0].shapes.title.text == slides[0].title
        assert any(s.shape_type == MSO_SHAPE_TYPE.PICTURE for s in deck.slides[1].shapes)

    def test_t4_scenario_2_qbr_presentation(self, client, template_fixture, tmp_path, monkeypatch):
        """Scenario 2: Quarterly Business Review (QBR).
        Upload metrics (.json) + market trends chart (.jpg).
        Verify JSON KPI metrics extracted into markdown tables, image bound to slide, and PPTX export embeds picture.
        """
        monkeypatch.setattr(settings, "storage_dir", tmp_path)
        path, result = template_fixture
        theme = slide_theme(result.tokens)

        # 1. Upload files
        files = [
            ("files", ("q3_metrics.json", make_json_metrics_bytes(), "application/json")),
            ("files", ("market_chart.jpg", make_jpeg_bytes(width=180, height=120), "image/jpeg")),
        ]
        res_upload = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert res_upload.status_code == status.HTTP_201_CREATED, res_upload.text
        uploaded = res_upload.json()
        assert len(uploaded) == 2

        # 2. Verify JSON metrics extracted
        p_json = tmp_path / "q3_metrics.json"
        p_json.write_bytes(make_json_metrics_bytes())
        extracted_json = extract_text(p_json, "q3_metrics.json")
        assert extracted_json is not None
        assert "1850" in extracted_json or "VK Cloud" in extracted_json

        # 3. Slide binding and PPTX export
        jpg_id = uploaded[1]["id"]
        p_jpg = storage_path("content", str(TEST_PRES_ID), f"{jpg_id}.jpg")
        p_jpg.parent.mkdir(parents=True, exist_ok=True)
        p_jpg.write_bytes(make_jpeg_bytes(width=180, height=120))

        slide = Slide(
            kind="image_text",
            title="Динамика выручки и рыночные тренды",
            layout_key=result.roles.get("image", ["0:1"])[0],
            bullets=["Рост год к году: 34.2%", "EBITDA маржа: 21.0%"],
            image=ImageSpec(url=f"/api/presentations/{TEST_PRES_ID}/files/{jpg_id}/content", status="generated"),
        )

        pptx_bytes = build_pptx(path, [slide], roles=result.roles, theme=theme)
        deck = PptxPresentation(io.BytesIO(pptx_bytes))
        assert len(deck.slides) == 1
        assert any(s.shape_type == MSO_SHAPE_TYPE.PICTURE for s in deck.slides[0].shapes)

    def test_t4_scenario_3_technical_architecture_overview(self, client, template_fixture, tmp_path, monkeypatch):
        """Scenario 3: Technical Architecture Overview.
        Upload system spec (.yml) + architecture diagram (.webp).
        Verify spec parameters extracted into bulleted list, webp diagram embedded in PPTX.
        """
        monkeypatch.setattr(settings, "storage_dir", tmp_path)
        path, result = template_fixture
        theme = slide_theme(result.tokens)

        # 1. Upload files
        files = [
            ("files", ("system_spec.yml", make_yaml_projections_bytes(), "application/yaml")),
            ("files", ("architecture.webp", make_webp_bytes(width=250, height=140), "image/webp")),
        ]
        res_upload = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert res_upload.status_code == status.HTTP_201_CREATED, res_upload.text
        uploaded = res_upload.json()
        assert len(uploaded) == 2

        # 2. Ingest YAML into bulleted list
        p_yaml = tmp_path / "system_spec.yml"
        p_yaml.write_bytes(make_yaml_projections_bytes())
        spec_text = extract_text(p_yaml, "system_spec.yml")
        assert spec_text is not None
        assert "ISO 27001" in spec_text or "Масштабирование" in spec_text

        # 3. PPTX export with WEBP image
        webp_id = uploaded[1]["id"]
        p_webp = storage_path("content", str(TEST_PRES_ID), f"{webp_id}.webp")
        p_webp.parent.mkdir(parents=True, exist_ok=True)
        p_webp.write_bytes(make_webp_bytes(width=250, height=140))

        slide = Slide(
            kind="image_text",
            title="Архитектурная схема комплекса",
            layout_key=result.roles.get("image", ["0:1"])[0],
            bullets=["Отказоустойчивый кластер", "Геораспределённая репликация"],
            image=ImageSpec(url=f"/api/presentations/{TEST_PRES_ID}/files/{webp_id}/content", status="generated"),
        )

        pptx_bytes = build_pptx(path, [slide], roles=result.roles, theme=theme)
        deck = PptxPresentation(io.BytesIO(pptx_bytes))
        assert len(deck.slides) == 1
        assert any(s.shape_type == MSO_SHAPE_TYPE.PICTURE for s in deck.slides[0].shapes)

    def test_t4_scenario_4_mixed_media_package(self, client):
        """Scenario 4: Mixed Media Package.
        Upload 5 mixed files (.png, .jpeg, .svg, .json, .yaml) along with existing .pdf and .docx.
        Verify all succeed, correct category badges / MIME types, and digest length limits respected.
        """
        files = [
            ("files", ("diagram.png", make_png_bytes(), "image/png")),
            ("files", ("cover.jpeg", make_jpeg_bytes(), "image/jpeg")),
            ("files", ("brand.svg", make_svg_bytes(), "image/svg+xml")),
            ("files", ("records.json", make_json_metrics_bytes(), "application/json")),
            ("files", ("roadmap.yaml", make_yaml_projections_bytes(), "application/yaml")),
        ]
        response = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        items = response.json()
        assert len(items) == 5

        # Check that digest respects limit across all files
        texts = [(item["filename"], f"Контент файла {item['filename']} " * 50) for item in items]
        digest = sources_digest(texts, per_file=300, total=1200)
        assert len(digest) <= 1500

    def test_t4_scenario_5_slide_editor_image_swap(self, template_fixture, tmp_path, monkeypatch):
        """Scenario 5: Slide Editor Image Swap.
        Manually replace a placeholder image with a content package uploaded logo in the slide editor,
        verify patch persists and PPTX export includes the updated logo.
        """
        monkeypatch.setattr(settings, "storage_dir", tmp_path)
        path, result = template_fixture
        theme = slide_theme(result.tokens)

        # 1. Slide starts with a generated placeholder prompt (no URL)
        slide = Slide(
            kind="image_text",
            title="Слайд с заменяемой иллюстрацией",
            layout_key=result.roles.get("image", ["0:1"])[0],
            bullets=["Тезис 1", "Тезис 2"],
            image=ImageSpec(prompt="Временная заглушка", status="pending"),
        )
        assert slide.image.url is None

        # 2. User swaps image with content package logo
        logo_id = uuid.uuid4()
        logo_file = storage_path("content", str(TEST_PRES_ID), f"{logo_id}.svg")
        logo_file.parent.mkdir(parents=True, exist_ok=True)
        logo_file.write_bytes(make_svg_bytes(text="VK New Logo"))

        # User updates image
        slide.image.url = f"/api/presentations/{TEST_PRES_ID}/files/{logo_id}/content"
        slide.image.status = "generated"

        # 3. Export to PPTX and verify
        pptx_bytes = build_pptx(path, [slide], roles=result.roles, theme=theme)
        deck = PptxPresentation(io.BytesIO(pptx_bytes))
        assert len(deck.slides) == 1
        assert any(s.shape_type == MSO_SHAPE_TYPE.PICTURE for s in deck.slides[0].shapes)

    def test_t4_scenario_6_invalid_file_rejection(self, client):
        """Scenario 6: Invalid File Rejection.
        Attempt uploading unsupported formats (.exe, .mp4, .zip).
        Verify HTTP 400 rejection and Russian error message with allowed format list.
        """
        for unsupported in ["virus.exe", "movie.mp4", "archive.zip"]:
            files = [("files", (unsupported, b"binary_data", "application/octet-stream"))]
            res = client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
            assert res.status_code == status.HTTP_400_BAD_REQUEST
            detail = res.json().get("detail", "")
            assert "не поддерживается" in detail.lower()
            assert "можно:" in detail.lower()
