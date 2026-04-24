"""Simple in-memory DOCX bundle. Read once, mutate parts, save atomically."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import zipfile
from typing import Iterable


@dataclass
class DocxBundle:
    """Holds all parts of a DOCX in memory as raw bytes, preserving order."""
    _parts: dict[str, bytes] = field(default_factory=dict)
    _order: list[str] = field(default_factory=list)

    @classmethod
    def read(cls, path: Path) -> "DocxBundle":
        bundle = cls()
        with zipfile.ZipFile(path, "r") as z:
            for name in z.namelist():
                bundle._parts[name] = z.read(name)
                bundle._order.append(name)
        return bundle

    def list_parts(self) -> Iterable[str]:
        return list(self._order)

    def has_part(self, name: str) -> bool:
        return name in self._parts

    def read_part(self, name: str) -> bytes:
        if name not in self._parts:
            raise KeyError(f"DOCX part not found: {name}")
        return self._parts[name]

    def write_part(self, name: str, data: bytes) -> None:
        if name not in self._parts:
            self._order.append(name)
        self._parts[name] = data

    def delete_part(self, name: str) -> None:
        if name in self._parts:
            del self._parts[name]
            self._order.remove(name)

    def save(self, path: Path) -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for name in self._order:
                z.writestr(name, self._parts[name])
        tmp.replace(path)
