from starblitz_engine.vision.layout import reading_order, xy_cut_order


def test_manga_reads_right_to_left_within_row():
    # Dos globos a la misma altura: en manga primero el de la derecha.
    boxes = [(100, 100, 200, 300), (400, 100, 500, 300)]
    assert xy_cut_order(boxes, "rtl") == [1, 0]
    assert xy_cut_order(boxes, "ltr") == [0, 1]


def test_rows_top_to_bottom_before_columns():
    boxes = [(0, 500, 100, 600), (300, 0, 400, 100), (0, 0, 100, 100)]
    assert xy_cut_order(boxes, "rtl") == [1, 2, 0]


def test_two_page_spread_right_page_first():
    panels = [(0, 0, 400, 300), (0, 320, 400, 600), (450, 0, 850, 600)]
    blocks = [(50, 50, 100, 100), (500, 50, 550, 100), (50, 400, 100, 450)]
    assert reading_order(blocks, panels, "rtl") == [1, 0, 2]


def test_blocks_outside_panels_form_pseudo_panels():
    panels = [(500, 0, 900, 400)]
    blocks = [(600, 50, 650, 100), (10, 10, 400, 400), (100, 100, 150, 150)]
    order = reading_order(blocks, panels, "rtl")
    # La viñeta de la derecha va primero; dentro de la pseudo-viñeta se lee por posición.
    assert order == [0, 2, 1]
