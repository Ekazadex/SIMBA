from pathlib import Path

from openpyxl import Workbook

from simba_forecast.bmkg_daily import load_daily_rr


def workbook(path: Path, station: str, rows, rr_only=False):
    wb = Workbook()
    sh = wb.active
    sh.append([None, 'ID WMO', ':  96745' if station == 'Kemayoran' else ':  97184'])
    sh.append([None, 'NAMA STASIUN', ':  Stasiun Meteorologi Kemayoran' if station == 'Kemayoran' else ':  Stasiun Klimatologi Sulawesi Selatan'])
    sh.append(['TANGGAL', 'RR'] if rr_only else ['TANGGAL', 'TN', 'RR'])
    for date, rain in rows:
        sh.append([date, rain] if rr_only else [date, 20, rain])
    wb.save(path)


def test_daily_rr_rejects_other_station_and_missing_codes_and_deduplicates(tmp_path):
    workbook(tmp_path / 'a.xlsx', 'Kemayoran', [('01-01-2025', 12), ('02-01-2025', 8888), ('03-01-2025', 0)], True)
    workbook(tmp_path / 'b.xlsx', 'Kemayoran', [('01-01-2025', 12), ('04-01-2025', 9999)])
    workbook(tmp_path / 'c.xlsx', 'Sulawesi', [('05-01-2025', 900)])
    records, audit = load_daily_rr(tmp_path)
    assert [r['date'] for r in records] == ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04']
    assert [r['rr_mm'] for r in records] == [12.0, None, 0.0, None]
    assert [r['quality'] for r in records] == ['observed_daily', 'missing_code_8888', 'observed_daily', 'missing_code_9999']
    assert records[0]['source_file'] == 'a.xlsx' and records[0]['source_row'] == 4
    assert audit['excluded_station_files'] == ['c.xlsx'] and audit['duplicate_date_rows'] == 1
    assert audit['missing_code_rows'] == 2 and audit['rainy_valid_days'] == 1


def test_conflicting_duplicate_is_disclosed_not_silently_replaced(tmp_path):
    workbook(tmp_path / 'a.xlsx', 'Kemayoran', [('01-01-2025', 10)])
    workbook(tmp_path / 'b.xlsx', 'Kemayoran', [('01-01-2025', 15)])
    records, audit = load_daily_rr(tmp_path)
    assert records[0]['rr_mm'] == 10.0
    assert audit['conflicts'][0]['date'] == '2025-01-01'
