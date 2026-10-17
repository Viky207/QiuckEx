import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { validateSync } from "class-validator";
import { PaymentsController, RecentPaymentsQuery } from "./payments.controller";
import { HorizonService } from "../transactions/horizon.service";

const WALLET = `G${"A".repeat(55)}`;

describe("PaymentsController", () => {
  let controller: PaymentsController;
  let horizonService: jest.Mocked<HorizonService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        {
          provide: HorizonService,
          useValue: {
            getPayments: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<PaymentsController>(PaymentsController);
    horizonService = module.get(HorizonService);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("recent()", () => {
    const mockPayments = {
      items: [
        {
          amount: "50.0000000",
          asset: "XLM",
          memo: "Invoice 1",
          timestamp: "2026-06-01T12:00:00Z",
          txHash: "tx_aaa",
          source: "GSOURCE1",
          destination: "GDEST1",
          status: "Success" as const,
          pagingToken: "100",
        },
        {
          amount: "100.0000000",
          asset: "XLM",
          memo: "Invoice 2",
          timestamp: "2026-06-15T10:00:00Z",
          txHash: "tx_bbb",
          source: "GSOURCE2",
          destination: "GDEST1",
          status: "Success" as const,
          pagingToken: "200",
        },
        {
          amount: "25.0000000",
          asset: "USDC",
          memo: null,
          timestamp: "2026-07-01T08:00:00Z",
          txHash: "tx_ccc",
          source: "GSOURCE3",
          destination: "GDEST1",
          status: "Success" as const,
          pagingToken: "300",
        },
      ],
      nextCursor: "300",
    };

    it("rejects missing or malformed addresses before making a Horizon call", () => {
      const query = Object.assign(new RecentPaymentsQuery(), { address: "" });
      expect(validateSync(query).some((error) => error.property === "address")).toBe(true);
      expect(horizonService.getPayments).not.toHaveBeenCalled();
    });

    it("rejects malformed cursors and out-of-range page sizes", () => {
      const query = Object.assign(new RecentPaymentsQuery(), {
        address: WALLET,
        cursor: "cursor/not-numeric",
        limit: 201,
      });
      const invalidFields = validateSync(query).map((error) => error.property);

      expect(invalidFields).toContain("cursor");
      expect(invalidFields).toContain("limit");
    });

    it("should return all payments when no since filter is given", async () => {
      horizonService.getPayments.mockResolvedValue(mockPayments);

      const result = await controller.recent({
        address: WALLET,
        limit: 20,
      });

      expect(result.items).toHaveLength(3);
      expect(horizonService.getPayments).toHaveBeenCalledWith(
        WALLET,
        undefined,
        20,
        undefined,
      );
    });

    it("should filter payments by ISO since timestamp", async () => {
      horizonService.getPayments.mockResolvedValue(mockPayments);

      const result = await controller.recent({
        address: WALLET,
        since: "2026-06-10T00:00:00Z",
        limit: 20,
      });

      // Only payments after 2026-06-10 should be returned
      expect(result.items).toHaveLength(2);
      expect(result.items[0].txHash).toBe("tx_bbb");
      expect(result.items[1].txHash).toBe("tx_ccc");
    });

    it("should filter payments by epoch-ms since timestamp", async () => {
      horizonService.getPayments.mockResolvedValue(mockPayments);

      // 2026-06-10T00:00:00Z in epoch ms
      const sinceMs = new Date("2026-06-10T00:00:00Z").getTime().toString();

      const result = await controller.recent({
        address: WALLET,
        since: sinceMs,
        limit: 20,
      });

      expect(result.items).toHaveLength(2);
    });

    it("should default limit to 20 when not specified", async () => {
      horizonService.getPayments.mockResolvedValue({
        items: [],
        nextCursor: undefined,
      });

      await controller.recent({ address: WALLET });

      expect(horizonService.getPayments).toHaveBeenCalledWith(
        WALLET,
        undefined,
        20,
        undefined,
      );
    });

    it("should return empty items when horizon returns no results", async () => {
      horizonService.getPayments.mockResolvedValue({
        items: [],
        nextCursor: undefined,
      });

      const result = await controller.recent({ address: WALLET });
      expect(result.items).toHaveLength(0);
    });

    it("rejects a malformed since timestamp with a stable validation code", async () => {
      await expect(controller.recent({
        address: WALLET,
        since: "not-a-date",
      })).rejects.toMatchObject({
        response: { code: "VALIDATION_ERROR" },
      });
      expect(horizonService.getPayments).not.toHaveBeenCalled();
    });

    it("passes the cursor to Horizon and returns its next cursor", async () => {
      horizonService.getPayments.mockResolvedValue(mockPayments);

      const result = await controller.recent({
        address: WALLET,
        limit: 2,
        cursor: "12345",
      });

      expect(horizonService.getPayments).toHaveBeenCalledWith(
        WALLET,
        undefined,
        2,
        "12345",
      );
      expect(result.nextCursor).toBe("300");
    });

    it("returns a stable error for an expired Horizon cursor", async () => {
      horizonService.getPayments.mockRejectedValue(new BadRequestException());

      await expect(controller.recent({
        address: WALLET,
        cursor: "12345",
      })).rejects.toMatchObject({
        response: { code: "PAYMENTS_CURSOR_EXPIRED" },
      });
    });

    it("returns a stable not-found error for an address absent from Horizon", async () => {
      horizonService.getPayments.mockRejectedValue(new NotFoundException());

      await expect(controller.recent({ address: WALLET })).rejects.toMatchObject({
        response: { code: "PAYMENTS_ACCOUNT_NOT_FOUND" },
      });
    });

    it("maps dependency failures to a stable unavailable response", async () => {
      horizonService.getPayments.mockRejectedValue(new Error("Horizon timeout"));

      await expect(controller.recent({ address: WALLET })).rejects.toMatchObject({
        response: { code: "PAYMENTS_UNAVAILABLE" },
      });
    });

    it("recovers on a safe retry after a dependency failure", async () => {
      horizonService.getPayments
        .mockRejectedValueOnce(new Error("Horizon timeout"))
        .mockResolvedValueOnce(mockPayments);

      await expect(controller.recent({ address: WALLET })).rejects.toMatchObject({
        response: { code: "PAYMENTS_UNAVAILABLE" },
      });
      await expect(controller.recent({ address: WALLET })).resolves.toMatchObject({
        items: mockPayments.items,
        nextCursor: mockPayments.nextCursor,
      });
    });
  });
});
