import unittest
from machine._proto import (
    encode_actuator_frame,
    encode_client_message,
    decode_sensor_frame,
    decode_server_message,
    decode_disabled_message,
)


class TestProto(unittest.TestCase):
    def test_encode_actuator_frame(self) -> None:
        frame = {
            "motors": [0.5, -0.75, 1.0, -0.25],
            "dribbler": 0.8,
            "kicker": True,
            "say": {"strategy": "defend"},
        }
        encoded = encode_actuator_frame(frame)
        self.assertGreater(len(encoded), 0)

        client_msg = encode_client_message(frame)
        self.assertGreater(len(client_msg), len(encoded))

    def test_decode_disabled_message(self) -> None:
        from machine._proto import ProtoWriter

        writer = ProtoWriter()
        writer.string(1, "5.7.1")
        writer.string(2, "Damaged robot")
        writer.float(3, 30.0)
        data = writer.finish()

        decoded = decode_disabled_message(data)
        self.assertEqual(decoded["rule"], "5.7.1")
        self.assertEqual(decoded["reason"], "Damaged robot")
        self.assertAlmostEqual(decoded["returnsIn"], 30.0, places=2)

    def test_decode_server_message_sensors(self) -> None:
        from machine._proto import ProtoWriter

        sub = ProtoWriter()
        sub.double(1, 15.5)
        sub.int32(2, 1)
        sub.string(3, "violet")
        sub.int32(4, 1)
        sub.bool(5, True)
        frame_bytes = sub.finish()

        writer = ProtoWriter()
        writer.bytes(1, frame_bytes)
        server_msg_bytes = writer.finish()

        msg = decode_server_message(server_msg_bytes)
        self.assertIsNotNone(msg)
        self.assertEqual(msg["type"], "sensors")
        self.assertAlmostEqual(msg["frame"]["clock"], 15.5, places=2)
        self.assertEqual(msg["frame"]["robot"], 1)
        self.assertEqual(msg["frame"]["team"], "violet")
        self.assertEqual(msg["frame"]["attackDirection"], 1)
        self.assertTrue(msg["frame"]["playing"])


if __name__ == "__main__":
    unittest.main()
