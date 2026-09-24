"""Tests for Milestone 1: Backend Ingestion & Content Endpoint.

Covers:
- Feature 1: Image Upload Validation (.png, .jpg, .jpeg, .webp, .svg)
- Feature 2: Structured Data Upload Validation (.json, .yaml, .yml)
- Feature 3: Content File Serving Endpoint (`GET /presentations/{id}/files/{file_id}/content`)
- Meta Options Allowed Content Extensions reflection
"""

import io
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient

from app.api.deps import get_current_user, get_db, get_optional_user, get_presentation_for_user
from app.core.config import settings
from app.core.storage import storage_path
from app.main import app
from app.models import ContentFile, Presentation, User
from app.models.base import utcnow
from app.pipeline.skills import get_skill, load_skills

TEST_USER_ID = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
FORBIDDEN_USER_ID = uuid.UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
TEST_PRES_ID = uuid.UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")
OTHER_PRES_ID = uuid.UUID("dddddddd-dddd-dddd-dddd-dddddddddddd")

EXPECTED_15_EXTENSIONS = [
    ".txt", ".md", ".csv", ".pdf", ".docx", ".pptx", ".xlsx",
    ".json", ".yaml", ".yml", ".png", ".jpg", ".jpeg", ".webp", ".svg",
]


class InMemoryDbSession:
    """Mock database session for fast, isolated tests."""

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
        matched_id = None
        pres_id = None
        for k, v in params.items():
            if isinstance(v, uuid.UUID):
                if v in self.files:
                    matched_id = v
                elif v in (TEST_PRES_ID, OTHER_PRES_ID):
                    pres_id = v
        if matched_id and matched_id in self.files:
            f = self.files[matched_id]
            if pres_id is None or f.presentation_id == pres_id:
                return f
            return None
        return None

    async def execute(self, stmt: Any) -> Any:
        class DummyResult:
            def first(self):
                return None

            def all(self):
                return []

        return DummyResult()


@pytest.fixture
def mock_db():
    return InMemoryDbSession()


@pytest.fixture
def test_user():
    return User(
        id=TEST_USER_ID,
        email="test@vk.team",
        full_name="Тестовый Пользователь",
        is_active=True,
    )


@pytest.fixture
def test_presentation(test_user):
    pres = Presentation(
        id=TEST_PRES_ID,
        owner_id=test_user.id,
        title="Тестовая презентация",
        purpose="product",
        brief="Краткое описание",
        status="draft",
        settings={},
    )
    pres.access_role = "owner"
    return pres


@pytest.fixture
def test_app_client(tmp_path, monkeypatch, mock_db, test_user, test_presentation):
    monkeypatch.setattr(settings, "storage_dir", tmp_path)

    async def override_get_current_user():
        return test_user

    async def override_get_optional_user():
        return test_user

    async def override_get_db():
        yield mock_db

    async def override_get_presentation(db, presentation_id, user, **kwargs):
        if presentation_id != TEST_PRES_ID:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Презентация не найдена")
        if user and user.id == FORBIDDEN_USER_ID:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Доступ запрещён")
        return test_presentation

    async def dummy_publish(*args, **kwargs):
        pass

    monkeypatch.setattr("app.api.routes.presentations.publish_presentation_update", dummy_publish)

    app.dependency_overrides[get_current_user] = override_get_current_user
    app.dependency_overrides[get_optional_user] = override_get_optional_user
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_presentation_for_user] = override_get_presentation

    load_skills.cache_clear()
    test_client = TestClient(app, raise_server_exceptions=False)
    yield test_client
    app.dependency_overrides.clear()


class TestMilestone1IngestionAndContentEndpoint:
    """Test suite for Milestone 1 backend ingestion and file serving."""

    def test_content_analyzer_extensions_list(self):
        """Verify content_analyzer.yaml contains exactly the 15 required extensions."""
        load_skills.cache_clear()
        skill = get_skill("content_analyzer")
        extensions = skill.params.get("extensions") or []
        assert isinstance(extensions, list)
        for ext in EXPECTED_15_EXTENSIONS:
            assert ext in extensions, f"Missing extension: {ext}"
        assert set(extensions) == set(EXPECTED_15_EXTENSIONS)

    def test_meta_options_reflects_all_15_extensions(self, test_app_client):
        """Verify GET /api/meta/options includes all 15 allowed content extensions."""
        response = test_app_client.get("/api/meta/options")
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        returned_extensions = set(data.get("content_extensions") or [])
        for ext in EXPECTED_15_EXTENSIONS:
            assert ext in returned_extensions, f"Extension {ext} not in /meta/options"

    @pytest.mark.parametrize("filename, mime", [
        ("photo.png", "image/png"),
        ("photo.jpg", "image/jpeg"),
        ("photo.jpeg", "image/jpeg"),
        ("photo.webp", "image/webp"),
        ("graphic.svg", "image/svg+xml"),
    ])
    def test_upload_image_formats_accepted(self, test_app_client, filename, mime):
        """Feature 1: Images (.png, .jpg, .jpeg, .webp, .svg) are accepted with 201 Created."""
        files = [("files", (filename, b"fake_image_bytes", mime))]
        response = test_app_client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        data = response.json()
        assert len(data) == 1
        assert data[0]["filename"] == filename

    @pytest.mark.parametrize("filename, mime", [
        ("data.json", "application/json"),
        ("config.yaml", "application/yaml"),
        ("pipeline.yml", "application/yaml"),
    ])
    def test_upload_structured_data_formats_accepted(self, test_app_client, filename, mime):
        """Feature 2: Structured data (.json, .yaml, .yml) is accepted with 201 Created."""
        files = [("files", (filename, b"key: value\n", mime))]
        response = test_app_client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        data = response.json()
        assert len(data) == 1
        assert data[0]["filename"] == filename

    @pytest.mark.parametrize("invalid_filename", [
        "script.sh", "program.exe", "bundle.zip", "test.py", "music.mp3"
    ])
    def test_upload_unsupported_formats_rejected(self, test_app_client, invalid_filename):
        """Unsupported formats are rejected with 400 Bad Request and Russian message."""
        files = [("files", (invalid_filename, b"data", "application/octet-stream"))]
        response = test_app_client.post(f"/api/presentations/{TEST_PRES_ID}/files", files=files)
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        error_msg = response.json().get("detail", "")
        assert "не поддерживается" in error_msg.lower()
        assert "можно:" in error_msg.lower()

    @pytest.mark.parametrize("ext, expected_mime, is_image", [
        (".png", "image/png", True),
        (".jpg", "image/jpeg", True),
        (".jpeg", "image/jpeg", True),
        (".webp", "image/webp", True),
        (".svg", "image/svg+xml", True),
        (".json", "application/json", False),
        (".yaml", "application/yaml", False),
        (".yml", "application/yaml", False),
        (".pdf", "application/pdf", False),
    ])
    def test_get_content_file_exact_mime_and_caching(
        self, test_app_client, mock_db, tmp_path, ext, expected_mime, is_image
    ):
        """Feature 3: GET content returns exact MIME type, Cache-Control, and Content-Disposition inline."""
        file_id = uuid.uuid4()
        filename = f"asset{ext}"
        payload = b"content-payload-bytes-12345"

        file_path = storage_path("content", str(TEST_PRES_ID), f"{file_id}{ext}")
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(payload)

        content_file = ContentFile(
            id=file_id,
            presentation_id=TEST_PRES_ID,
            filename=filename,
            content_type=expected_mime,
            size=len(payload),
            path=str(file_path),
        )
        mock_db.files[file_id] = content_file

        response = test_app_client.get(f"/api/presentations/{TEST_PRES_ID}/files/{file_id}/content")
        assert response.status_code == status.HTTP_200_OK
        assert response.content == payload

        # MIME type check
        ct = response.headers.get("content-type", "")
        assert expected_mime in ct

        # Cache-Control check
        cc = response.headers.get("cache-control", "")
        if is_image:
            assert "private, max-age=604800" in cc
        else:
            assert "private, no-cache" in cc

        # Content-Disposition check
        cd = response.headers.get("content-disposition", "")
        assert "inline" in cd
        assert filename in cd

    def test_get_content_file_fallback_mime(self, test_app_client, mock_db, tmp_path):
        """Fallback to content_file.content_type or application/octet-stream if unknown extension."""
        file_id = uuid.uuid4()
        file_path = storage_path("content", str(TEST_PRES_ID), f"{file_id}.unknown")
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(b"unknown data")

        content_file = ContentFile(
            id=file_id,
            presentation_id=TEST_PRES_ID,
            filename="test.unknown",
            content_type="custom/type",
            size=12,
            path=str(file_path),
        )
        mock_db.files[file_id] = content_file

        response = test_app_client.get(f"/api/presentations/{TEST_PRES_ID}/files/{file_id}/content")
        assert response.status_code == status.HTTP_200_OK
        assert "custom/type" in response.headers.get("content-type", "")

    def test_get_content_file_not_found_in_db(self, test_app_client):
        """Return 404 when file does not exist in DB."""
        missing_id = uuid.uuid4()
        response = test_app_client.get(f"/api/presentations/{TEST_PRES_ID}/files/{missing_id}/content")
        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert "не найден" in response.json().get("detail", "").lower()

    def test_get_content_file_missing_on_disk(self, test_app_client, mock_db):
        """Return 404 when file exists in DB but is missing from disk."""
        file_id = uuid.uuid4()
        content_file = ContentFile(
            id=file_id,
            presentation_id=TEST_PRES_ID,
            filename="lost.png",
            content_type="image/png",
            size=100,
            path="/tmp/non_existent_path_lost_file.png",
        )
        mock_db.files[file_id] = content_file

        response = test_app_client.get(f"/api/presentations/{TEST_PRES_ID}/files/{file_id}/content")
        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert "диске" in response.json().get("detail", "").lower()

    def test_get_content_file_wrong_presentation_id(self, test_app_client, mock_db, tmp_path):
        """Return 404 when requesting a file belonging to another presentation."""
        file_id = uuid.uuid4()
        file_path = storage_path("content", str(TEST_PRES_ID), f"{file_id}.png")
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(b"png data")

        content_file = ContentFile(
            id=file_id,
            presentation_id=TEST_PRES_ID,
            filename="belonging_to_pres1.png",
            content_type="image/png",
            size=8,
            path=str(file_path),
        )
        mock_db.files[file_id] = content_file

        # Request using OTHER_PRES_ID
        response = test_app_client.get(f"/api/presentations/{OTHER_PRES_ID}/files/{file_id}/content")
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_get_content_file_forbidden_user(self, test_app_client, mock_db, tmp_path):
        """Return 403 when user is forbidden."""
        file_id = uuid.uuid4()
        file_path = storage_path("content", str(TEST_PRES_ID), f"{file_id}.png")
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(b"png data")

        content_file = ContentFile(
            id=file_id,
            presentation_id=TEST_PRES_ID,
            filename="protected.png",
            content_type="image/png",
            size=8,
            path=str(file_path),
        )
        mock_db.files[file_id] = content_file

        async def override_forbidden_user():
            return User(id=FORBIDDEN_USER_ID, email="forbidden@vk.team", is_active=True)

        app.dependency_overrides[get_optional_user] = override_forbidden_user
        try:
            response = test_app_client.get(f"/api/presentations/{TEST_PRES_ID}/files/{file_id}/content")
            assert response.status_code == status.HTTP_403_FORBIDDEN
        finally:
            async def _reset_user():
                return test_user

            app.dependency_overrides[get_optional_user] = _reset_user

    def test_get_content_file_anonymous_user(self, test_app_client, mock_db, tmp_path):
        """Allow unauthenticated user (OptionalUser = None) to fetch preview content."""
        file_id = uuid.uuid4()
        file_path = storage_path("content", str(TEST_PRES_ID), f"{file_id}.png")
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(b"public preview bytes")

        content_file = ContentFile(
            id=file_id,
            presentation_id=TEST_PRES_ID,
            filename="preview.png",
            content_type="image/png",
            size=20,
            path=str(file_path),
        )
        mock_db.files[file_id] = content_file

        async def override_none_user():
            return None

        app.dependency_overrides[get_optional_user] = override_none_user
        try:
            response = test_app_client.get(f"/api/presentations/{TEST_PRES_ID}/files/{file_id}/content")
            assert response.status_code == status.HTTP_200_OK
            assert response.content == b"public preview bytes"
        finally:
            async def _reset_user():
                return test_user

            app.dependency_overrides[get_optional_user] = _reset_user

