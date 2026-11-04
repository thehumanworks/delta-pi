{
  description = "Development environment for the Delta pi extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    deltanix = {
      url = "github:thehumanworks/deltanix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, deltanix, ... }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
      ];
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShellNoCC {
            packages = with pkgs; [
              nodejs_22
              bun
              git
              openssh
              bashInteractive
              coreutils
              curl
              fd
              ripgrep
              prettier
              nixfmt
              deltanix.packages.${system}.delta-cli
            ];

            SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";

            shellHook = ''
              # Keep this absolute: the e2e harness runs pi in temporary checkouts.
              export PATH="$PWD/node_modules/.bin:$PATH"

              # Pi and TypeScript come from the project's npm lock, not a global install.
              if [[ ! -x node_modules/.bin/pi || ! -x node_modules/.bin/tsc ]]; then
                echo "Installing development dependencies from package-lock.json…"
                if ! npm ci --include=dev --no-audit --no-fund; then
                  echo "Dependency setup failed. Run nix develop from the checkout root and retry." >&2
                  exit 1
                fi
              fi
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
