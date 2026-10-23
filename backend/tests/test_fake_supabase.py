"""FakeSupabase.rpc: the strict scripted stand-in for supabase.rpc(...) (H2-2.2)."""
from uuid import uuid4
import pytest
from tests.helpers import FakeSupabase, pg_error

def test_unscripted_rpc_fails_naming_the_function():
    with pytest.raises(AssertionError, match=r"rpc\('save_individual'\)"):
        FakeSupabase().rpc("save_individual", {"p_name": "x"}).execute()

def test_rpc_returns_scripted_data_and_records_params():
    sb = FakeSupabase().on_rpc("save_individual", data={"replayed": False})
    assert sb.rpc("save_individual", {"p_name": "Ann"}).execute().data == {"replayed": False}
    assert sb.rpc_params("save_individual") == [{"p_name": "Ann"}]
    assert [c.verb for c in sb.calls_to("save_individual", "rpc")] == ["rpc"]

def test_rpc_data_callable_receives_the_call():
    sb = FakeSupabase().on_rpc("f", data=lambda call: call.payload["p_x"] * 2)
    assert sb.rpc("f", {"p_x": 21}).execute().data == 42

def test_rpc_error_is_raised_with_its_sqlstate():
    sb = FakeSupabase().on_rpc("save_individual", error=pg_error("P0409"))
    with pytest.raises(Exception) as info:
        sb.rpc("save_individual", {}).execute()
    assert info.value.code == "P0409"

def test_rpc_params_must_be_json_serialisable():
    sb = FakeSupabase().on_rpc("f", data=1)
    with pytest.raises(AssertionError, match="JSON"):
        sb.rpc("f", {"p_id": uuid4()}).execute()

def test_rpc_times_then_next_rule():
    sb = FakeSupabase().on_rpc("f", data=1, times=1).on_rpc("f", data=2)
    assert [sb.rpc("f").execute().data for _ in range(3)] == [1, 2, 2]

def test_rpc_and_table_rules_never_answer_each_other():
    sb = FakeSupabase().on_rpc("individuals", data=[]).on("rescore_batch", "select", data=[])
    with pytest.raises(AssertionError):
        sb.table("individuals").select("*").execute()
    with pytest.raises(AssertionError):
        sb.rpc("rescore_batch", {"p_rows": []}).execute()

def test_rpc_null_result_stays_none():
    assert FakeSupabase().on_rpc("f", data=None).rpc("f").execute().data is None
