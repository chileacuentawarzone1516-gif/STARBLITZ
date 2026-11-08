"""Integridad de los diálogos en el PC: el original solo se borra donde hay una traducción válida."""

from starblitz_engine.pipeline.processor import has_valid_translation, plan_clean
from starblitz_engine.projects.schema import Region


def region(rid: str, source: str = "待って", translation: str = "", **kw) -> Region:
    return Region(id=rid, order=0, bbox=(0, 0, 10, 10), layout_box=(0, 0, 10, 10), source_text=source, translation=translation, **kw)


def test_traduccion_valida():
    assert has_valid_translation(region("a", translation="¡Espera!"))
    assert not has_valid_translation(region("a", translation=""))
    assert not has_valid_translation(region("a", translation="   "))
    assert not has_valid_translation(region("a", translation="Lo siento, no puedo ayudar con eso."))
    assert not has_valid_translation(region("a", translation="¡Espera!", flags=["refused"]))
    assert not has_valid_translation(region("a", translation="¡Espera!", flags=["untranslated"]))


def test_solo_se_borra_con_traduccion_valida():
    ok = region("ok", translation="Hola")
    vacio = region("vacio", translation="")
    rechazo = region("rechazo", translation="", flags=["refused"], status="review")
    sfx = region("sfx", translation="", erase=False)
    erase, kept = plan_clean([ok, vacio, rechazo, sfx])
    assert [r.id for r in erase] == ["ok"]
    assert kept == {"vacio", "rechazo"}  # el sfx no se borra por diseño, no es «conservado por falta de traducción»


def test_lo_aprobado_o_editado_manda():
    editado = region("ed", translation="", status="edited")
    aprobado = region("ap", translation="Hola", status="approved")
    erase, kept = plan_clean([editado, aprobado])
    assert [r.id for r in erase] == ["ed", "ap"]
    assert kept == set()


def test_sin_traducir_nada_no_se_borra_nada():
    regs = [region(f"r{i}", translation="") for i in range(3)]
    erase, kept = plan_clean(regs)
    assert erase == [] and kept == {"r0", "r1", "r2"}
