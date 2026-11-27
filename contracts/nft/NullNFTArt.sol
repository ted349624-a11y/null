// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title NullNFTArt
/// @notice Fully on-chain metadata for null_ NFTs: a mirrored 8x8 pattern drawn from the collection seed and
///         the token id, in one hue per collection, on the null_ black. No server or IPFS involved.
library NullNFTArt {
    using Strings for uint256;

    uint256 private constant CELL = 48;
    uint256 private constant ORIGIN = 64;

    function tokenURI(string memory name_, string memory symbol_, uint256 id, bytes32 seed, uint256 perNFT)
        internal
        pure
        returns (string memory)
    {
        (string memory svg, uint256 cells) = image(symbol_, id, seed);
        string memory inside = string.concat(formatUnits18(perNFT), " ", symbol_);
        bytes memory json = abi.encodePacked(
            '{"name":"', name_, " #", id.toString(),
            '","description":"Holds ', inside,
            ". Turn it into coins or turn coins back into an NFT any time at null_.",
            '","image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)),
            '","attributes":[{"trait_type":"Coins inside","value":"', inside,
            '"},{"trait_type":"Cells","display_type":"number","value":', cells.toString(), "}]}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(json));
    }

    function contractURI(string memory name_, string memory symbol_, bytes32 seed, uint256 perNFT)
        internal
        pure
        returns (string memory)
    {
        (string memory svg,) = image(symbol_, 0, seed);
        bytes memory json = abi.encodePacked(
            '{"name":"', name_,
            '","description":"An NFT collection on null_. Every NFT holds ', formatUnits18(perNFT), " ", symbol_,
            ' and can be turned into coins, or coins back into an NFT, at any time.","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)), '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(json));
    }

    /// @return svg the picture; cells how many squares it has (a light trait)
    function image(string memory symbol_, uint256 id, bytes32 seed) internal pure returns (string memory svg, uint256 cells) {
        uint256 h = uint256(keccak256(abi.encode(seed, id)));
        string memory hue = (uint256(seed) % 360).toString();
        bytes memory body;
        for (uint256 y = 0; y < 8; y++) {
            for (uint256 x = 0; x < 4; x++) {
                uint256 bit = y * 4 + x;
                if ((h >> bit) & 1 == 0) continue;
                uint256 shade = (h >> (32 + bit * 2)) & 3; // four lightness steps
                string memory fill = string.concat("hsl(", hue, ",85%,", (38 + shade * 14).toString(), "%)");
                body = abi.encodePacked(body, _rect(x, y, fill), _rect(7 - x, y, fill));
                cells += 2;
            }
        }
        svg = string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#08090b"/>',
                body,
                '<text x="64" y="488" font-family="ui-monospace,Menlo,monospace" font-size="22" fill="#eceff1">',
                symbol_, id == 0 ? "" : string.concat(" #", id.toString()),
                '</text><text x="448" y="488" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="22" font-weight="700" fill="#eceff1">null<tspan fill="#c6ff3d">_</tspan></text></svg>'
            )
        );
    }

    function _rect(uint256 x, uint256 y, string memory fill) private pure returns (bytes memory) {
        return abi.encodePacked(
            '<rect x="', (ORIGIN + x * CELL).toString(), '" y="', (ORIGIN + y * CELL).toString(),
            '" width="44" height="44" rx="6" fill="', fill, '"/>'
        );
    }

    /// @notice 18-decimal amount as text without trailing zeros, e.g. 10000, 0.5, 12.25
    function formatUnits18(uint256 v) internal pure returns (string memory) {
        uint256 whole = v / 1e18;
        uint256 frac = v % 1e18;
        if (frac == 0) return whole.toString();
        bytes memory f = bytes(frac.toString());
        bytes memory padded = new bytes(18);
        uint256 pad = 18 - f.length;
        for (uint256 i = 0; i < 18; i++) padded[i] = i < pad ? bytes1("0") : f[i - pad];
        uint256 end = 18;
        while (end > 0 && padded[end - 1] == "0") end--;
        bytes memory out = new bytes(end);
        for (uint256 i = 0; i < end; i++) out[i] = padded[i];
        return string.concat(whole.toString(), ".", string(out));
    }
}
