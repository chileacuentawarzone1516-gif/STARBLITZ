"""Verifica la integración ONNX de Manga OCR con un modelo sintético de igual firma.

No mide precisión (eso requiere los pesos reales); comprueba entradas, salidas,
búsqueda por haz, parada en EOS y decodificación del vocabulario.
"""

import json

import numpy as np
import onnx
import pytest
from onnx import TensorProto, helper, numpy_helper

from starblitz_engine.vision.detector import DetectedBlock
from starblitz_engine.vision.ocr.manga_ocr import MangaOCREngine, _banned_tokens, _post_process

VOCAB = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"] + [chr(0x3042 + i) for i in range(1100)]


def _encoder(path):
    x = helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, ["b", 3, 224, 224])
    y = helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, ["b", 4, 8])
    # Reduce la imagen a 4x8 valores: suficiente para la prueba de forma.
    shape = numpy_helper.from_array(np.array([0, 4, -1], np.int64), "shape")
    nodes = [
        helper.make_node("Reshape", ["pixel_values", "shape"], ["r"]),
        helper.make_node("ReduceMean", ["r"], ["m"], axes=[2], keepdims=1),
        helper.make_node("Tile", ["m", "rep"], ["last_hidden_state"]),
    ]
    rep = numpy_helper.from_array(np.array([1, 1, 8], np.int64), "rep")
    g = helper.make_graph(nodes, "enc", [x], [y], [shape, rep])
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)])
    m.ir_version = 8
    onnx.save(m, path)


def _decoder(path, script):
    """Decoder determinista: el siguiente token depende solo de la longitud de la secuencia."""
    vocab = len(VOCAB)
    table = np.full((len(script) + 2, vocab), -10.0, np.float32)
    for pos, tok in enumerate(script):
        table[pos, tok] = 10.0
    table[len(script):, 3] = 10.0  # EOS al final
    ids = helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["b", "s"])
    hid = helper.make_tensor_value_info("encoder_hidden_states", TensorProto.FLOAT, ["b", 4, 8])
    out = helper.make_tensor_value_info("logits", TensorProto.FLOAT, ["b", "s", vocab])
    nodes = [
        helper.make_node("Shape", ["input_ids"], ["shp"]),
        helper.make_node("Gather", ["shp", "one"], ["len"], axis=0),
        helper.make_node("Sub", ["len", "one"], ["pos"]),
        helper.make_node("Gather", ["table", "pos"], ["row"], axis=0),
        helper.make_node("Unsqueeze", ["row", "axes01"], ["row3"]),
        helper.make_node("Expand", ["row3", "outshape"], ["logits"]),
        helper.make_node("Concat", ["bs", "vocab"], ["outshape"], axis=0),
        helper.make_node("Slice", ["shp", "zero1", "two1"], ["bs"]),
        helper.make_node("ReduceSum", ["encoder_hidden_states"], ["unused"], keepdims=0),
    ]
    inits = [
        numpy_helper.from_array(table, "table"),
        numpy_helper.from_array(np.array(1, np.int64), "one"),
        numpy_helper.from_array(np.array([0, 1], np.int64), "axes01"),
        numpy_helper.from_array(np.array([vocab], np.int64), "vocab"),
        numpy_helper.from_array(np.array([0], np.int64), "zero1"),
        numpy_helper.from_array(np.array([2], np.int64), "two1"),
    ]
    g = helper.make_graph(nodes, "dec", [ids, hid], [out], inits)
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)])
    m.ir_version = 8
    onnx.save(m, path)


@pytest.fixture
def model_dir(tmp_path):
    script = [5 + 10, 5 + 20, 5 + 30]  # tres caracteres
    _encoder(tmp_path / "encoder_model.onnx")
    _decoder(tmp_path / "decoder_model.onnx", script)
    (tmp_path / "vocab.txt").write_text("\n".join(VOCAB), encoding="utf-8")
    (tmp_path / "generation_config.json").write_text(json.dumps(
        {"decoder_start_token_id": 2, "eos_token_id": 3, "pad_token_id": 0, "max_length": 300,
         "no_repeat_ngram_size": 3, "num_beams": 4, "length_penalty": 2.0}))
    return tmp_path, "".join(VOCAB[t] for t in script)


def test_manga_ocr_onnx_pipeline(model_dir):
    path, expected = model_dir
    engine = MangaOCREngine(path, "cpu")
    img = np.full((300, 200, 3), 255, np.uint8)
    res = engine.recognize(img, DetectedBlock(bbox=(20, 20, 180, 280), vertical=True, line_size=30))
    assert res.text == expected
    assert 0.9 < res.confidence <= 1.0


def test_no_repeat_ngram_and_postprocess():
    assert _banned_tokens([2, 7, 8, 7], 3) == []
    assert _banned_tokens([2, 7, 8, 7, 8], 3) == [7]
    assert _post_process("A b…12") == "Ａｂ．．．１２"  # igual que manga-ocr (jaconv.h2z)
