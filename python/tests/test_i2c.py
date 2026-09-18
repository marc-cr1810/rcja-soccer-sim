"""Unit tests for machine.I2C and simulated sensor devices."""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import machine
from machine import I2C
from machine._backend import Runtime
from machine import constants


class TestI2C(unittest.TestCase):
    def setUp(self) -> None:
        self.rt = Runtime.get()
        self.rt.connected = True
        self.rt.last_frame = {
            "ball": {"strength": 0.8, "bearing": 0.0},
            "compass": {"heading": 0.0},
            "gyro": {"rate": 1.5},
        }

    def test_i2c_scan(self) -> None:
        i2c = I2C()
        devices = i2c.scan()
        self.assertIn(constants.I2C_ADDR_MPU6050, devices)
        self.assertIn(constants.I2C_ADDR_IR_SEEKER, devices)
        self.assertIn(constants.I2C_ADDR_BNO055, devices)

    def test_mpu6050_whoami(self) -> None:
        i2c = I2C()
        whoami = i2c.readfrom_mem(constants.I2C_ADDR_MPU6050, 0x75, 1)
        self.assertEqual(whoami, bytes([0x68]))

    def test_ir_seeker_direction(self) -> None:
        i2c = I2C()
        # Register 0x42 is direction 1-9; bearing 0.0 is straight ahead (sector 5)
        dir_byte = i2c.readfrom_mem(constants.I2C_ADDR_IR_SEEKER, 0x42, 1)
        self.assertEqual(dir_byte, bytes([5]))


if __name__ == "__main__":
    unittest.main()
