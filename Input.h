#ifndef INPUT_H
#define INPUT_H

#include "./Bin/Include/glad/glad.h"
#include "./Bin/Include/GLFW/glfw3.h"
#include <iostream>

#include "Transform.h"

enum KeyCode {
	W = GLFW_KEY_W,
	A = GLFW_KEY_A,
	S = GLFW_KEY_S,
	D = GLFW_KEY_D
};

class Input {
public:
	static bool GetKeyDown(KeyCode kc, GLFWwindow* window) {
		if (glfwGetKey(window, kc) == GLFW_PRESS) {
			return true;
		}
		else {
			return false;
		}
	}

	static void WASD(Transform* trans, double increment, GLFWwindow* window) {
		if (GetKeyDown(KeyCode::W, window)) {
			trans->position.y += increment;
		} else if (GetKeyDown(KeyCode::A, window)) {
			trans->position.x -= increment;
		}
		else if (GetKeyDown(KeyCode::S, window)) {
			trans->position.y -= increment;
		}
		else if (GetKeyDown(KeyCode::D, window)) {
			trans->position.x += increment;
		}
	}
};

#endif